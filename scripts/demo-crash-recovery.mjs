#!/usr/bin/env node
/**
 * Narrated crash-recovery demo for krusch-coding-harness.
 *
 * Runs the real code path exercised by test/integration/crash-smoke.test.js:
 *   1. stage a 2-file change in PostgreSQL (krusch_staged_diffs)
 *   2. apply it with KruschStateManager.applyDiffBatch in a child process
 *   3. SIGKILL the child right after the first file is renamed into place
 *   4. show the torn state (file A new, file B old, temp file left, rows APPLYING)
 *   5. run KruschStateManager.recoverInFlightApplies and show the repaired state
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
const say = async (line = '', pause = 450) => {
  console.log(line);
  await sleep(pause);
};

/**
 * Prints the on-disk and database state of the 2-file batch.
 * @param {string} dir - Temporary project directory.
 * @param {number[]} ids - Staged diff row ids.
 */
async function showState(dir, ids) {
  const srcDir = path.join(dir, 'src');
  for (const name of ['moduleA.js', 'moduleB.js']) {
    const firstLine = fs.readFileSync(path.join(srcDir, name), 'utf-8').split('\n')[0];
    await say(`   disk  src/${name.padEnd(11)} ${firstLine}`, 250);
  }
  const temps = fs.readdirSync(srcDir).filter((f) => f.includes('.krusch-tmp-'));
  await say(`   disk  temp files      ${temps.length ? temps.join(', ') : '(none)'}`, 250);
  const rows = await query('SELECT id, file_path, status FROM krusch_staged_diffs WHERE id = ANY($1) ORDER BY id', [ids]);
  for (const row of rows.rows) {
    await say(`   db    ${row.file_path.padEnd(17)} status=${row.status}`, 250);
  }
}

/**
 * Applies the batch in a child process and kills it after the first rename.
 * @param {string} taskId - Harness task id.
 * @param {number[]} ids - Staged diff row ids.
 * @param {string} dir - Temporary project directory.
 * @returns {Promise<string>} Exit signal of the killed child.
 */
function applyAndKill(taskId, ids, dir) {
  const workerFile = path.join(dir, 'worker.mjs');
  fs.writeFileSync(
    workerFile,
    `import { KruschStateManager } from '${path.join(ROOT, 'src/brain/state-manager.js')}';\n` +
      `await KruschStateManager.applyDiffBatch('${taskId}', [${ids.join(', ')}], '${dir}');\n`
  );
  const child = fork(workerFile, {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, NODE_ENV: 'test', KRUSCH_ENABLE_TEST_HOOKS: '1', KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME: '1' },
  });
  return new Promise((resolve, reject) => {
    child.on('message', (msg) => {
      if (msg.readyForKill) child.kill('SIGKILL');
    });
    child.on('exit', (_code, signal) => resolve(signal));
    child.on('error', reject);
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-demo-'));
  const taskId = `demo_crash_${Date.now()}`;
  try {
    await say('$ node scripts/demo-crash-recovery.mjs', 700);
    await say('▶ 1. Stage a 2-file change (PostgreSQL: krusch_staged_diffs)');
    await KruschStateManager.createTask({ id: taskId, goal: 'Demo: SIGKILL mid-apply recovery', projectPath: dir, phase: HARNESS_PHASES.APPROVAL_GATE });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const files = {
      'src/moduleA.js': ['// moduleA: ORIGINAL\nexport const a = 1;\n', '// moduleA: UPDATED\nexport const a = 2;\n'],
      'src/moduleB.js': ['// moduleB: ORIGINAL\nexport const b = 1;\n', '// moduleB: UPDATED\nexport const b = 2;\n'],
    };
    const ids = [];
    for (const [rel, [base, staged]] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, rel), base);
      const diff = await KruschStateManager.stageDiff(taskId, { filePath: rel, originalContent: base, stagedContent: staged, diffPatch: `update ${rel}`, projectPath: dir });
      ids.push(diff.id);
    }
    await KruschStateManager.recordVerificationRun(taskId, { command: 'npm test', exitCode: 0, stdout: 'ok', stderr: '', passed: true });
    await showState(dir, ids);

    await say('');
    await say('▶ 2. applyDiffBatch() in a child process; SIGKILL right after file 1 is renamed', 600);
    const signal = await applyAndKill(taskId, ids, dir);
    await say(`   child exited with signal ${signal}`, 700);

    await say('');
    await say('▶ 3. Torn state left behind by the crash');
    await showState(dir, ids);

    await say('');
    await say('▶ 4. Restart → recoverInFlightApplies()', 600);
    const recovered = await KruschStateManager.recoverInFlightApplies(dir);
    for (const r of recovered) await say(`   recovery  diff ${r.diffId ?? r.id ?? '?'} → ${r.outcome}`, 300);

    await say('');
    await say('▶ 5. State after recovery');
    await showState(dir, ids);
    await say('');
    await say('✅ Both files are back to their original content, the temp file is gone,', 200);
    await say('   and both rows are PENDING again, ready for a clean re-apply.', 1500);
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
