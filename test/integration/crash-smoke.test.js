import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { query, withTransaction, pool, isEphemeralMode } from '../../src/brain/pool.js';
import { KruschStateManager, canonicalizePaths } from '../../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

test('Real Crash Smoke: kill -9 mid-apply on multi-file batch, cold fresh-process recovery, assert disk/journal/DB, and clean retry', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-smoke-crash-'));
  const taskId = `smoke_crash_${Date.now()}`;

  try {
    // 1. Initialize Task in PostgreSQL
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Smoke test kill -9 recovery on multi-file batch',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });

    // 2. Setup ground-truth files on physical disk
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    const baseA = '// Module A (Original Base Content)\nexport function getA() { return "A"; }\n';
    const baseB = '// Module B (Original Base Content)\nexport function getB() { return "B"; }\n';
    fs.writeFileSync(path.join(testDir, 'src/moduleA.js'), baseA, 'utf-8');
    fs.writeFileSync(path.join(testDir, 'src/moduleB.js'), baseB, 'utf-8');

    // 3. Stage multi-file diffs into PostgreSQL
    const stagedA = '// Module A (Updated Staged Content)\nexport function getA() { return "A_UPDATED"; }\n';
    const stagedB = '// Module B (Updated Staged Content)\nexport function getB() { return "B_UPDATED"; }\n';

    const diffA = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/moduleA.js',
      originalContent: baseA,
      stagedContent: stagedA,
      diffPatch: 'update moduleA',
      projectPath: testDir
    });

    const diffB = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/moduleB.js',
      originalContent: baseB,
      stagedContent: stagedB,
      diffPatch: 'update moduleB',
      projectPath: testDir
    });

    // 4. Record passing verification run to satisfy APPROVAL_GATE requirements
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm run test:unit',
      exitCode: 0,
      stdout: '2 suites passed',
      stderr: '',
      passed: true
    });

    // 5. Perform the apply via real KruschStateManager.applyDiffBatch,
    // driven by an explicit deterministic sync point (test hook after first rename) and terminated via SIGKILL (kill -9).
    const markerFile = path.join(testDir, '.crash-marker');
    let workerPid = null;
    if (isEphemeralMode()) {
      const prevHooks = process.env.KRUSCH_ENABLE_TEST_HOOKS;
      const prevPause = process.env.KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME;
      const prevMarker = process.env.KRUSCH_TEST_HOOK_MARKER_FILE;
      const prevSim = process.env.KRUSCH_TEST_HOOK_SIMULATE_SIGKILL_IN_PROCESS;
      process.env.KRUSCH_ENABLE_TEST_HOOKS = '1';
      process.env.KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME = '1';
      process.env.KRUSCH_TEST_HOOK_MARKER_FILE = markerFile;
      process.env.KRUSCH_TEST_HOOK_SIMULATE_SIGKILL_IN_PROCESS = '1';
      try {
        const res = await KruschStateManager.applyDiffBatch(taskId, [diffA.id, diffB.id], testDir);
        assert.strictEqual(res.signal, 'SIGKILL');
      } finally {
        if (prevHooks === undefined) delete process.env.KRUSCH_ENABLE_TEST_HOOKS; else process.env.KRUSCH_ENABLE_TEST_HOOKS = prevHooks;
        if (prevPause === undefined) delete process.env.KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME; else process.env.KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME = prevPause;
        if (prevMarker === undefined) delete process.env.KRUSCH_TEST_HOOK_MARKER_FILE; else process.env.KRUSCH_TEST_HOOK_MARKER_FILE = prevMarker;
        if (prevSim === undefined) delete process.env.KRUSCH_TEST_HOOK_SIMULATE_SIGKILL_IN_PROCESS; else process.env.KRUSCH_TEST_HOOK_SIMULATE_SIGKILL_IN_PROCESS = prevSim;
      }
    } else {
      const stateManagerPath = path.join(REPO_ROOT, 'src/brain/state-manager.js');
      const workerScript =
        `import { KruschStateManager } from ${JSON.stringify(stateManagerPath)};\n` +
        `async function runWorker() {\n` +
        `  await KruschStateManager.applyDiffBatch(${JSON.stringify(taskId)}, [${diffA.id}, ${diffB.id}], ${JSON.stringify(testDir)});\n` +
        `}\n` +
        `runWorker().catch(err => {\n` +
        `  console.error(err);\n` +
        `  process.exit(1);\n` +
        `});\n`;

      const workerFile = path.join(testDir, 'worker.mjs');
      fs.writeFileSync(workerFile, workerScript, 'utf-8');

      const child = fork(workerFile, {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          KRUSCH_ENABLE_TEST_HOOKS: '1',
          KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME: '1',
          KRUSCH_TEST_HOOK_MARKER_FILE: markerFile
        }
      });
      workerPid = child.pid;

      await new Promise((resolve, reject) => {
        child.on('message', (msg) => {
          if (msg && msg.readyForKill) {
            // Send SIGKILL (kill -9) to simulate violent crash mid-batch immediately after first file rename
            child.kill('SIGKILL');
          }
        });

        child.on('exit', (_code, signal) => {
          try {
            assert.strictEqual(signal, 'SIGKILL');
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        child.on('error', reject);
      });
    }

    // 6. Assert Inconsistent Mid-Crash State
    // (a) DB staged_diffs status is APPLYING
    const checkApplying = await query(
      'SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC',
      [diffA.id, diffB.id]
    );
    assert.strictEqual(checkApplying.rows[0].status, 'APPLYING');
    assert.strictEqual(checkApplying.rows[1].status, 'APPLYING');

    // (b) DB krusch_apply_journal is APPLYING with canonical project_path and base preimage metadata
    const midJournalRes = await query(
      'SELECT id, project_path, state, files, completed_at FROM krusch_apply_journal WHERE task_id = $1 ORDER BY id ASC',
      [taskId]
    );
    assert.strictEqual(midJournalRes.rows.length, 1);
    assert.strictEqual(midJournalRes.rows[0].state, 'APPLYING');
    assert.strictEqual(midJournalRes.rows[0].completed_at, null);
    assert.strictEqual(midJournalRes.rows[0].project_path, canonicalizePaths(testDir, '.').projectPath);
    const midJournalFiles = typeof midJournalRes.rows[0].files === 'string'
      ? JSON.parse(midJournalRes.rows[0].files)
      : midJournalRes.rows[0].files;
    assert.strictEqual(midJournalFiles.length, 2);
    assert.strictEqual(midJournalFiles[0].originalContent, baseA);
    assert.strictEqual(midJournalFiles[0].diskExisted, true);
    assert.strictEqual(midJournalFiles[1].originalContent, baseB);
    assert.strictEqual(midJournalFiles[1].diskExisted, true);

    // (c) Physical disk is inconsistent (moduleA renamed to stagedA, moduleB still baseB, temp file exists for moduleB)
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleA.js'), 'utf-8'), stagedA);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleB.js'), 'utf-8'), baseB);
    const midDirFiles = fs.readdirSync(path.join(testDir, 'src'));
    const tempFileB = midDirFiles.find(f => f.startsWith('.moduleB.js.krusch-tmp-'));
    assert.ok(tempFileB, 'Sibling temp file for moduleB should exist mid-crash');

    // 7. Start Up Again: Run Krusch Startup Recovery Protocol in a fresh cold Node process (when backed by PostgreSQL)
    let recovered;
    let pruned;
    if (isEphemeralMode()) {
      recovered = await KruschStateManager.recoverInFlightApplies(testDir);
      pruned = await KruschStateManager.pruneExpiredLeases();
    } else {
      const poolPath = path.join(REPO_ROOT, 'src/brain/pool.js');
      const stateManagerPath = path.join(REPO_ROOT, 'src/brain/state-manager.js');
      const recoverWorkerFile = path.join(testDir, 'recover-worker.mjs');
      const recoverWorkerScript =
        `import { pool } from ${JSON.stringify(poolPath)};\n` +
        `import { KruschStateManager } from ${JSON.stringify(stateManagerPath)};\n` +
        `const recovered = await KruschStateManager.recoverInFlightApplies(${JSON.stringify(testDir)});\n` +
        `const pruned = await KruschStateManager.pruneExpiredLeases();\n` +
        `await new Promise((resolve, reject) => {\n` +
        `  process.send({ pid: process.pid, recovered, pruned }, (err) => (err ? reject(err) : resolve()));\n` +
        `});\n` +
        `await pool.end();\n` +
        `process.exit(0);\n`;
      fs.writeFileSync(recoverWorkerFile, recoverWorkerScript, 'utf-8');

      const recoveryPayload = await new Promise((resolve, reject) => {
        let ipcMsg = null;
        const recoverChild = fork(recoverWorkerFile, {
          stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
          env: { ...process.env }
        });

        recoverChild.on('message', (msg) => {
          if (msg && Array.isArray(msg.recovered)) {
            ipcMsg = msg;
          }
        });

        recoverChild.on('exit', (code, signal) => {
          try {
            assert.strictEqual(code, 0, `recover-worker exited with code=${code} signal=${signal}`);
            assert.ok(ipcMsg, 'recover-worker must deliver { recovered, pruned } over IPC');
            resolve(ipcMsg);
          } catch (err) {
            reject(err);
          }
        });

        recoverChild.on('error', reject);
      });

      assert.notStrictEqual(recoveryPayload.pid, process.pid);
      assert.notStrictEqual(recoveryPayload.pid, workerPid);
      recovered = recoveryPayload.recovered;
      pruned = recoveryPayload.pruned;
    }

    assert.ok(Array.isArray(pruned));
    assert.strictEqual(recovered.length, 2);
    assert.strictEqual(recovered[0].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');
    assert.strictEqual(recovered[1].outcome, 'BATCH_ROLLBACK_REVERTED_TO_PENDING');

    // 8. Assert Complete Post-Recovery Consistency:
    // (a) DB: Both diff rows reverted to PENDING
    const checkPost = await query(
      'SELECT id, status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC',
      [diffA.id, diffB.id]
    );
    assert.strictEqual(checkPost.rows[0].status, 'PENDING');
    assert.strictEqual(checkPost.rows[1].status, 'PENDING');

    // (b) DB: krusch_apply_journal transitioned from APPLYING -> ROLLED_BACK
    const postJournalRes = await query(
      'SELECT id, state, completed_at, error_message FROM krusch_apply_journal WHERE task_id = $1 ORDER BY id ASC',
      [taskId]
    );
    assert.strictEqual(postJournalRes.rows.length, 1);
    assert.strictEqual(postJournalRes.rows[0].state, 'ROLLED_BACK');
    assert.ok(postJournalRes.rows[0].completed_at);
    assert.strictEqual(postJournalRes.rows[0].error_message, null);

    // (c) Disk: moduleA rolled back to baseA! moduleB is at baseB!
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleA.js'), 'utf-8'), baseA);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleB.js'), 'utf-8'), baseB);

    // (d) Orphaned temp file unlinked
    const postDirFiles = fs.readdirSync(path.join(testDir, 'src'));
    const postTempFileB = postDirFiles.find(f => f.startsWith('.moduleB.js.krusch-tmp-'));
    assert.strictEqual(postTempFileB, undefined, 'Orphaned temp file should be unlinked on recovery');

    // (e) Audit event recorded in PostgreSQL
    const eventRes = await query(
      `SELECT event_type, payload FROM krusch_events WHERE task_id = $1 AND event_type = 'recovery_performed'`,
      [taskId]
    );
    assert.strictEqual(eventRes.rows.length >= 2, true);

    // (f) Explain diagnostic reports consistent next transitions
    const exp = await KruschStateManager.explainTaskStatus(taskId);
    assert.strictEqual(exp.phase, 'APPROVAL_GATE');
    assert.strictEqual(exp.diffSummary.pending, 2);
    assert.strictEqual(exp.diffSummary.applying, 0);

    // 9. Clean Retry: Verify subsequent applyDiffBatch succeeds cleanly after recovery
    const retryRes = await KruschStateManager.applyDiffBatch(taskId, [diffA.id, diffB.id], testDir);
    assert.strictEqual(retryRes.status, 'APPLIED');
    assert.strictEqual(retryRes.appliedCount, 2);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleA.js'), 'utf-8'), stagedA);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/moduleB.js'), 'utf-8'), stagedB);

    const finalJournals = await query(
      'SELECT state FROM krusch_apply_journal WHERE task_id = $1 ORDER BY id ASC',
      [taskId]
    );
    assert.deepStrictEqual(
      finalJournals.rows.map(r => r.state),
      ['ROLLED_BACK', 'APPLIED']
    );

    await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
  } finally {
    await query(
      `UPDATE krusch_tasks SET phase = $1 WHERE id = $2 AND phase NOT IN ('COMMITTED', 'ABORTED')`,
      [HARNESS_PHASES.ABORTED, taskId]
    );
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test('INV-CRASH-03: Step 3 journal+status intent is atomic and recoverInFlightApplies reconciles authoritative journal rows', async () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-journal-atomic-'));
  const taskId = `journal_atomic_${Date.now()}`;

  try {
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Verify atomic Step 3 journal transaction and authoritative journal recovery',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });

    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    const base1 = '// f1 original\n';
    const base2 = '// f2 original\n';
    const staged1 = '// f1 staged\n';
    const staged2 = '// f2 staged\n';
    fs.writeFileSync(path.join(testDir, 'src/f1.js'), base1, 'utf-8');
    fs.writeFileSync(path.join(testDir, 'src/f2.js'), base2, 'utf-8');

    const d1 = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/f1.js',
      originalContent: base1,
      stagedContent: staged1,
      diffPatch: 'f1',
      projectPath: testDir
    });
    const d2 = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/f2.js',
      originalContent: base2,
      stagedContent: staged2,
      diffPatch: 'f2',
      projectPath: testDir
    });

    // Part A: Fault mid-Step-3 after INSERT INTO krusch_apply_journal rolls back journal + temp files atomically
    const step3FailTx = async (callback) => {
      return await withTransaction(async (client) => {
        let count = 0;
        const wrapped = {
          ...client,
          query: async (sql, params) => {
            const res = await client.query(sql, params);
            count += 1;
            if (count === 2) {
              const err = new Error('simulated crash between journal insert and apply_started event');
              err.code = '57P01';
              throw err;
            }
            return res;
          }
        };
        return await callback(wrapped);
      });
    };

    await assert.rejects(
      () => KruschStateManager.applyDiffBatch(taskId, null, testDir, { withJournalTransactionFn: step3FailTx }),
      (err) => err.code === '57P01'
    );

    const journalsAfterFail = await query('SELECT * FROM krusch_apply_journal WHERE task_id = $1', [taskId]);
    assert.strictEqual(journalsAfterFail.rows.length, 0, 'Rolled back Step 3 transaction must leave zero APPLYING journal rows');
    const diffsAfterFail = await query(
      'SELECT status FROM krusch_staged_diffs WHERE id IN ($1, $2) ORDER BY id ASC',
      [d1.id, d2.id]
    );
    assert.strictEqual(diffsAfterFail.rows.every(r => r.status === 'PENDING'), true);
    const leftoverTemps = fs.readdirSync(path.join(testDir, 'src')).filter(f => f.includes('.krusch-tmp-'));
    assert.deepStrictEqual(leftoverTemps, []);

    // Part B: Active krusch_apply_journal row whose diffs are still PENDING is reconciled using journal preimage
    const canonicalProject = canonicalizePaths(testDir, '.').projectPath;
    fs.writeFileSync(path.join(testDir, 'src/f1.js'), staged1, 'utf-8');
    await query(
      `INSERT INTO krusch_apply_journal (task_id, project_path, state, files, created_at)
       VALUES ($1, $2, 'APPLYING', $3, NOW())`,
      [
        taskId,
        canonicalProject,
        JSON.stringify([
          {
            diffId: d1.id,
            filePath: 'src/f1.js',
            stagedHash: d1.sha256_hash,
            originalHash: d1.original_sha256,
            originalContent: base1,
            diskExisted: true,
            fullPath: path.join(canonicalProject, 'src/f1.js')
          },
          {
            diffId: d2.id,
            filePath: 'src/f2.js',
            stagedHash: d2.sha256_hash,
            originalHash: d2.original_sha256,
            originalContent: base2,
            diskExisted: true,
            fullPath: path.join(canonicalProject, 'src/f2.js')
          }
        ])
      ]
    );

    // Also insert an orphaned journal row on a separate task with zero matching diffs to verify it closes to ROLLED_BACK
    const orphanTaskId = `orphan_journal_${Date.now()}`;
    await KruschStateManager.createTask({
      id: orphanTaskId,
      goal: 'Verify orphaned journal row with zero matching staged diffs closes to ROLLED_BACK',
      projectPath: testDir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });
    const emptyJournalRes = await query(
      `INSERT INTO krusch_apply_journal (task_id, project_path, state, files, created_at)
       VALUES ($1, $2, 'APPLYING', $3, NOW()) RETURNING id`,
      [orphanTaskId, canonicalProject, JSON.stringify([{ diffId: 999999999 }])]
    );

    const rec = await KruschStateManager.recoverInFlightApplies(testDir);
    assert.strictEqual(rec.length, 2);
    assert.strictEqual(rec.every(r => r.outcome === 'BATCH_ROLLBACK_REVERTED_TO_PENDING'), true);
    assert.strictEqual(fs.readFileSync(path.join(testDir, 'src/f1.js'), 'utf-8'), base1);

    const closedJournals = await query(
      'SELECT id, state FROM krusch_apply_journal WHERE task_id IN ($1, $2) ORDER BY id ASC',
      [taskId, orphanTaskId]
    );
    assert.strictEqual(closedJournals.rows.length, 2);
    assert.strictEqual(closedJournals.rows.every(r => r.state === 'ROLLED_BACK'), true);
    assert.strictEqual(
      closedJournals.rows.find(r => r.id === emptyJournalRes.rows[0].id)?.state,
      'ROLLED_BACK'
    );
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, orphanTaskId]);
  } finally {
    await query(
      `UPDATE krusch_tasks SET phase = $1 WHERE id = $2 AND phase NOT IN ('COMMITTED', 'ABORTED')`,
      [HARNESS_PHASES.ABORTED, taskId]
    );
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

test.after(async () => {
  await pool.end();
});
