#!/usr/bin/env node
/**
 * Narrated crash-recovery demo for krusch-coding-harness.
 *
 * Runs the real code path exercised by test/integration/crash-smoke.test.js:
 *   1. stage a 2-file change in PostgreSQL (krusch_staged_diffs)
 *   2. apply it with KruschStateManager.applyDiffBatch in a child process
 *   3. SIGKILL the child right after the first file is renamed into place
 *   4. show the torn state (file A new, file B old, temp file left, journal & rows APPLYING)
 *   5. spawn a fresh recovery child process (cold DB pool) running recoverInFlightApplies + pruneExpiredLeases
 *
 * Usage: node scripts/demo-crash-recovery.mjs   (requires the harness PostgreSQL DB)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query, pool } from '../src/brain/pool.js';
import { KruschStateManager } from '../src/brain/state-manager.js';
import { HARNESS_PHASES } from '../src/workflow/fsm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = async (line = '', pause = 120) => {
  console.log(line);
  await sleep(pause);
};

/**
 * Prints the on-disk and database state of the 2-file batch and durable apply journal.
 * @param {string} dir - Temporary project directory.
 * @param {number[]} ids - Staged diff row ids.
 * @param {string} taskId - Harness task id.
 */
async function showState(dir, ids, taskId) {
  const srcDir = path.join(dir, 'src');
  for (const name of ['moduleA.js', 'moduleB.js']) {
    const firstLine = fs.readFileSync(path.join(srcDir, name), 'utf-8').split('\n')[0];
    await say(`   disk  src/${name.padEnd(11)} ${firstLine}`, 80);
  }
  const temps = fs.readdirSync(srcDir).filter((f) => f.includes('.krusch-tmp-'));
  await say(`   disk  temp files      ${temps.length ? temps.join(', ') : '(none)'}`, 80);
  const rows = await query(
    'SELECT id, file_path, status FROM krusch_staged_diffs WHERE id = ANY($1) ORDER BY id',
    [ids]
  );
  for (const row of rows.rows) {
    await say(`   db    ${row.file_path.padEnd(17)} status=${row.status}`, 80);
  }
  const journalRes = await query(
    'SELECT id, state FROM krusch_apply_journal WHERE task_id = $1 ORDER BY id DESC LIMIT 1',
    [taskId]
  );
  const journalRow = journalRes.rows[0] || null;
  await say(
    `   db    apply_journal     state=${journalRow ? `${journalRow.state} (id=${journalRow.id})` : '(none)'}`,
    80
  );
  return { temps, diffs: rows.rows, journalState: journalRow?.state || null };
}

/**
 * Applies the batch in a child process and kills it after the first rename.
 * @param {string} taskId - Harness task id.
 * @param {number[]} ids - Staged diff row ids.
 * @param {string} dir - Temporary project directory.
 * @returns {Promise<{ pid: number, signal: string }>} PID and exit signal of the killed child.
 */
function applyAndKill(taskId, ids, dir) {
  const workerFile = path.join(dir, 'worker.mjs');
  const stateManagerPath = path.join(ROOT, 'src/brain/state-manager.js');
  fs.writeFileSync(
    workerFile,
    `import { KruschStateManager } from ${JSON.stringify(stateManagerPath)};\n` +
      `await KruschStateManager.applyDiffBatch(${JSON.stringify(taskId)}, [${ids.join(', ')}], ${JSON.stringify(dir)});\n`,
    'utf-8'
  );
  const child = fork(workerFile, {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      KRUSCH_ENABLE_TEST_HOOKS: '1',
      KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME: '1'
    }
  });
  const pid = child.pid;
  return new Promise((resolve, reject) => {
    child.on('message', (msg) => {
      if (msg && msg.readyForKill) child.kill('SIGKILL');
    });
    child.on('exit', (_code, signal) => resolve({ pid, signal }));
    child.on('error', reject);
  });
}

/**
 * Spawns a fresh child Node process that connects cold to PostgreSQL,
 * runs recoverInFlightApplies + pruneExpiredLeases, reports over IPC, closes pool, and exits 0.
 * @param {string} dir - Temporary project directory.
 * @returns {Promise<{ pid: number, recovered: Array<object>, pruned: Array<object> }>}
 */
function recoverInFreshProcess(dir) {
  const recoverWorkerFile = path.join(dir, 'recover-worker.mjs');
  const poolPath = path.join(ROOT, 'src/brain/pool.js');
  const stateManagerPath = path.join(ROOT, 'src/brain/state-manager.js');
  fs.writeFileSync(
    recoverWorkerFile,
    `import { pool } from ${JSON.stringify(poolPath)};\n` +
      `import { KruschStateManager } from ${JSON.stringify(stateManagerPath)};\n` +
      `const recovered = await KruschStateManager.recoverInFlightApplies(${JSON.stringify(dir)});\n` +
      `const pruned = await KruschStateManager.pruneExpiredLeases();\n` +
      `await new Promise((resolve, reject) => {\n` +
      `  process.send({ pid: process.pid, recovered, pruned }, (err) => (err ? reject(err) : resolve()));\n` +
      `});\n` +
      `await pool.end();\n` +
      `process.exit(0);\n`,
    'utf-8'
  );
  const child = fork(recoverWorkerFile, {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env }
  });
  return new Promise((resolve, reject) => {
    let payload = null;
    child.on('message', (msg) => {
      if (msg && Array.isArray(msg.recovered)) {
        payload = msg;
      }
    });
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`recover-worker exited with code=${code} signal=${signal}`));
        return;
      }
      if (!payload) {
        reject(new Error('recover-worker exited without IPC payload'));
        return;
      }
      resolve(payload);
    });
    child.on('error', reject);
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-demo-'));
  const taskId = `demo_crash_${Date.now()}`;
  try {
    await say('$ node scripts/demo-crash-recovery.mjs', 150);
    await say('▶ 1. Stage a 2-file change (PostgreSQL: krusch_staged_diffs)');
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Demo: SIGKILL mid-apply recovery',
      projectPath: dir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const files = {
      'src/moduleA.js': ['// moduleA: ORIGINAL\nexport const a = 1;\n', '// moduleA: UPDATED\nexport const a = 2;\n'],
      'src/moduleB.js': ['// moduleB: ORIGINAL\nexport const b = 1;\n', '// moduleB: UPDATED\nexport const b = 2;\n']
    };
    const ids = [];
    for (const [rel, [base, staged]] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, rel), base);
      const diff = await KruschStateManager.stageDiff(taskId, {
        filePath: rel,
        originalContent: base,
        stagedContent: staged,
        diffPatch: `update ${rel}`,
        projectPath: dir
      });
      ids.push(diff.id);
    }
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'npm test',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      passed: true
    });
    await showState(dir, ids, taskId);

    await say('');
    await say('▶ 2. applyDiffBatch() in a child process; SIGKILL right after file 1 is renamed', 150);
    const { pid: killedPid, signal } = await applyAndKill(taskId, ids, dir);
    await say(`   worker pid=${killedPid} exited with signal ${signal}`, 150);

    await say('');
    await say('▶ 3. Torn state left behind by the crash');
    const midState = await showState(dir, ids, taskId);
    if (midState.journalState !== 'APPLYING') {
      throw new Error(`Expected mid-crash journal state APPLYING, got ${midState.journalState}`);
    }

    await say('');
    await say('▶ 4. Cold fresh-process restart -> recoverInFlightApplies() + pruneExpiredLeases()', 150);
    const { pid: recoveryPid, recovered, pruned } = await recoverInFreshProcess(dir);
    await say(`   fresh recovery worker pid=${recoveryPid} (pruned expired leases=${pruned.length})`, 100);
    for (const r of recovered) {
      await say(`   recovery  diff ${r.diffId ?? r.id ?? '?'} -> ${r.outcome}`, 100);
    }

    await say('');
    await say('▶ 5. State after fresh-process recovery');
    const postState = await showState(dir, ids, taskId);
    if (postState.journalState !== 'ROLLED_BACK') {
      throw new Error(`Expected post-recovery journal state ROLLED_BACK, got ${postState.journalState}`);
    }
    await say('');
    await say('✅ Both files are back to their original content, the temp file is gone,', 100);
    await say('   krusch_apply_journal is ROLLED_BACK, and both rows are PENDING again.', 150);
  } finally {
    await query('UPDATE krusch_tasks SET phase = $1 WHERE id = $2', [HARNESS_PHASES.ABORTED, taskId]).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`❌ demo failed: ${err.message}`);
  process.exitCode = 1;
});
