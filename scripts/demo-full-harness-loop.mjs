#!/usr/bin/env node
/**
 * End-to-end 5-step execution demo for krusch-coding-harness.
 *
 * Exercises the real PostgreSQL state manager, Bubblewrap sandbox runner, and POSIX
 * write-ahead apply journal with zero mocks:
 *   1. Stage a flawed AI patch in PostgreSQL (krusch_staged_diffs); working tree stays untouched
 *   2. Run isolated Bubblewrap sandbox tests (exitCode=1) -> applyDiffBatch() refuses -> rejectStagedDiff()
 *   3. Stage the repaired 2-file integer-cent patch and verify in isolated sandbox (exitCode=0, PASS)
 *   4. Inject SIGKILL mid-applyDiffBatch() after file 1 rename -> cold worker runs recoverInFlightApplies()
 *   5. Re-run applyDiffBatch() cleanly -> both files swapped onto disk and journal committed (APPLIED)
 *
 * Usage: node scripts/demo-full-harness-loop.mjs   (requires the harness PostgreSQL DB)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { query, pool } from '../src/brain/pool.js';
import { KruschStateManager } from '../src/brain/state-manager.js';
import { KruschVerificationContract } from '../src/verify/contract.js';
import { HARNESS_PHASES } from '../src/workflow/fsm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = async (line = '', pause = 70) => {
  console.log(line);
  await sleep(pause);
};

async function showState(dir, ids, taskId) {
  const srcDir = path.join(dir, 'src');
  for (const name of ['billing.js', 'ledger.js']) {
    const firstLine = fs.readFileSync(path.join(srcDir, name), 'utf-8').split('\n')[0];
    await say(`   disk  src/${name.padEnd(11)} ${firstLine}`, 45);
  }
  const temps = fs.readdirSync(srcDir).filter((f) => f.includes('.krusch-'));
  await say(`   disk  temp files      ${temps.length ? temps.join(', ') : '(none)'}`, 45);
  const rows = await query(
    'SELECT id, file_path, status FROM krusch_staged_diffs WHERE id = ANY($1) ORDER BY id',
    [ids]
  );
  for (const row of rows.rows) {
    await say(`   db    ${row.file_path.padEnd(17)} status=${row.status} (id=${row.id})`, 45);
  }
  const journalRes = await query(
    'SELECT id, state FROM krusch_apply_journal WHERE task_id = $1 ORDER BY id DESC LIMIT 1',
    [taskId]
  );
  const journalRow = journalRes.rows[0] || null;
  await say(
    `   db    apply_journal     state=${journalRow ? `${journalRow.state} (id=${journalRow.id})` : '(none)'}`,
    45
  );
  return { temps, diffs: rows.rows, journalState: journalRow?.state || null };
}

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
      if (msg && Array.isArray(msg.recovered)) payload = msg;
    });
    child.on('exit', (code, signal) => {
      if (code !== 0) return reject(new Error(`recover-worker exited with code=${code} signal=${signal}`));
      if (!payload) return reject(new Error('recover-worker exited without IPC payload'));
      resolve(payload);
    });
    child.on('error', reject);
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-loop-demo-'));
  const taskId = `demo_loop_${Date.now()}`;

  const baseBilling = [
    '// billing.js: ORIGINAL (v1)',
    'export function invoiceTotalCents(unitCents, qty) {',
    '  return unitCents * qty;',
    '}',
    ''
  ].join('\n');

  const baseLedger = [
    '// ledger.js: ORIGINAL (v1)',
    'export const LEDGER_SCHEMA_VERSION = 1;',
    ''
  ].join('\n');

  // Flawed AI candidate: uses float math (0.1 + 0.2 rounding bug on 1999 * 3 with 10% fee)
  const flawedBilling = [
    '// billing.js: FLAWED_AI_DRAFT (float drift)',
    'export function invoiceTotalCents(unitCents, qty, feeBps = 0) {',
    '  const dollars = (unitCents / 100) * qty * (1 + feeBps / 10000);',
    '  return Math.floor(dollars * 100); // BUG: truncates 6596.7c -> 6596c instead of half-up 6597c',
    '}',
    ''
  ].join('\n');

  // Fixed AI candidate: exact integer basis-point arithmetic
  const fixedBilling = [
    '// billing.js: UPDATED_VERIFIED (exact integer bps)',
    'export function invoiceTotalCents(unitCents, qty, feeBps = 0) {',
    '  const subtotal = unitCents * qty;',
    '  return Math.round((subtotal * (10000 + feeBps)) / 10000);',
    '}',
    ''
  ].join('\n');

  const fixedLedger = [
    '// ledger.js: UPDATED_VERIFIED (v2 feeBps)',
    'export const LEDGER_SCHEMA_VERSION = 2;',
    ''
  ].join('\n');

  const testFileContent = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { invoiceTotalCents } from '../src/billing.js';",
    "test('integer basis-point fee preserves exact half-up cent rounding', () => {",
    '  assert.equal(invoiceTotalCents(1999, 3, 1000), 6597);',
    '});',
    ''
  ].join('\n');

  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
    fs.writeFileSync(path.join(dir, 'src/billing.js'), baseBilling);
    fs.writeFileSync(path.join(dir, 'src/ledger.js'), baseLedger);
    fs.writeFileSync(path.join(dir, 'test/billing.test.js'), testFileContent);

    await say('$ node scripts/demo-full-harness-loop.mjs', 90);
    await say('▶ 1. Stage flawed AI candidate in PostgreSQL (working tree stays untouched)');
    await KruschStateManager.createTask({
      id: taskId,
      goal: 'Add basis-point fee support to invoiceTotalCents',
      projectPath: dir,
      phase: HARNESS_PHASES.APPROVAL_GATE
    });

    const badDiff = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/billing.js',
      originalContent: baseBilling,
      stagedContent: flawedBilling,
      diffPatch: 'flawed float fee patch',
      projectPath: dir
    });
    await showState(dir, [badDiff.id], taskId);

    await say('');
    await say('▶ 2. Isolated sandbox test fails -> applyDiffBatch() refuses -> diff REJECTED');
    const badRun = await KruschVerificationContract.runInStagedTree(dir, [badDiff], {
      command: 'node --test test/billing.test.js'
    });
    await say(`   sandbox (${badRun.sandboxType}, net=disabled) -> exitCode=${badRun.exitCode} passed=${badRun.passed}`, 70);
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'node --test test/billing.test.js',
      exitCode: badRun.exitCode,
      stdout: badRun.stdout,
      stderr: badRun.stderr,
      passed: badRun.passed
    });

    let blockedMsg = '';
    try {
      await KruschStateManager.applyDiffBatch(taskId, [badDiff.id], dir);
    } catch (err) {
      blockedMsg = err.message;
    }
    await say(`   gate  ${blockedMsg}`, 70);
    await KruschStateManager.rejectStagedDiff(taskId, badDiff.id, 'Failed integer-cent rounding test');
    await KruschStateManager.releaseLease(taskId, 'src/billing.js', dir);
    await showState(dir, [badDiff.id], taskId);

    await say('');
    await say('▶ 3. Stage repaired 2-file integer-bps batch -> isolated sandbox PASS');
    const goodA = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/billing.js',
      originalContent: baseBilling,
      stagedContent: fixedBilling,
      diffPatch: 'exact integer bps fee',
      projectPath: dir
    });
    const goodB = await KruschStateManager.stageDiff(taskId, {
      filePath: 'src/ledger.js',
      originalContent: baseLedger,
      stagedContent: fixedLedger,
      diffPatch: 'bump ledger schema v2',
      projectPath: dir
    });
    const goodIds = [goodA.id, goodB.id];

    const goodRun = await KruschVerificationContract.runInStagedTree(dir, [goodA, goodB], {
      command: 'node --test test/billing.test.js'
    });
    if (!goodRun.passed) {
      throw new Error(`Expected repaired patch to pass sandbox tests: ${goodRun.stderr}`);
    }
    await say(`   sandbox (${goodRun.sandboxType}, net=disabled) -> exitCode=${goodRun.exitCode} passed=${goodRun.passed}`, 70);
    await KruschStateManager.recordVerificationRun(taskId, {
      command: 'node --test test/billing.test.js',
      exitCode: goodRun.exitCode,
      stdout: goodRun.stdout,
      stderr: goodRun.stderr,
      passed: true
    });

    await say('');
    await say('▶ 4. SIGKILL mid-applyDiffBatch() after file 1 rename -> cold recoverInFlightApplies()');
    const { pid: killedPid, signal } = await applyAndKill(taskId, goodIds, dir);
    await say(`   worker pid=${killedPid} terminated with ${signal} (torn state on disk):`, 70);
    const torn = await showState(dir, goodIds, taskId);
    if (torn.journalState !== 'APPLYING') {
      throw new Error(`Expected mid-crash journal state APPLYING, got ${torn.journalState}`);
    }

    const { pid: recPid, recovered } = await recoverInFreshProcess(dir);
    await say(`   cold recovery worker pid=${recPid} -> ${recovered.map((r) => `diff ${r.id ?? r.diffId}:${r.outcome}`).join(', ')}`, 70);
    const afterRecovery = await showState(dir, goodIds, taskId);
    if (afterRecovery.journalState !== 'ROLLED_BACK') {
      throw new Error(`Expected ROLLED_BACK journal, got ${afterRecovery.journalState}`);
    }

    await say('');
    await say('▶ 5. Clean re-apply of verified batch -> journal & both files APPLIED');
    await KruschStateManager.applyDiffBatch(taskId, goodIds, dir);
    const finalState = await showState(dir, goodIds, taskId);
    if (finalState.journalState !== 'APPLIED') {
      throw new Error(`Expected final journal state APPLIED, got ${finalState.journalState}`);
    }
    await say('');
    await say('✅ Flawed AI patch rejected before disk write, mid-apply SIGKILL cleanly rolled back,', 70);
    await say('   and verified 2-file fix applied (status=APPLIED, journal=APPLIED).', 90);
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
