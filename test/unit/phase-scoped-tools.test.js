import test from 'node:test';
import assert from 'node:assert';
import { KruschTools } from '../../src/tools/index.js';
import { HARNESS_PHASES } from '../../src/workflow/fsm.js';

test('KruschTools: getDefinitions returns phase-scoped tool subsets', () => {
  const tools = new KruschTools('task_test_123', process.cwd());

  // Global / Unscoped
  const allTools = tools.getDefinitions();
  const allNames = allTools.map(t => t.name);
  assert.ok(allNames.includes('read_file'));
  assert.ok(allNames.includes('stage_diff'));
  assert.ok(allNames.includes('search_symbols'));
  assert.ok(allNames.includes('run_command'));
  assert.ok(allNames.includes('apply_staged_diff'));

  // PLAN phase: read-only discovery + finish_plan (stage_diff and apply_staged_diff strictly withheld)
  const planTools = tools.getDefinitions(HARNESS_PHASES.PLAN);
  const planNames = planTools.map(t => t.name);
  assert.ok(planNames.includes('read_file'));
  assert.ok(planNames.includes('search_symbols'));
  assert.ok(planNames.includes('finish_plan'));
  assert.ok(!planNames.includes('stage_diff'), 'stage_diff must be withheld in PLAN phase');
  assert.ok(!planNames.includes('run_command'), 'run_command must be withheld in PLAN phase');
  assert.ok(!planNames.includes('apply_staged_diff'), 'apply_staged_diff must be withheld in PLAN phase');

  // IMPLEMENT phase: read_file, search_symbols, stage_diff, request_verification
  const implTools = tools.getDefinitions(HARNESS_PHASES.IMPLEMENT);
  const implNames = implTools.map(t => t.name);
  assert.ok(implNames.includes('read_file'));
  assert.ok(implNames.includes('search_symbols'));
  assert.ok(implNames.includes('stage_diff'));
  assert.ok(implNames.includes('request_verification'));
  assert.ok(!implNames.includes('run_command'), 'run_command must be withheld in IMPLEMENT phase');
  assert.ok(!implNames.includes('apply_staged_diff'));

  // VERIFY phase: read_file, run_command (stage_diff strictly withheld)
  const verifyTools = tools.getDefinitions(HARNESS_PHASES.VERIFY);
  const verifyNames = verifyTools.map(t => t.name);
  assert.ok(verifyNames.includes('read_file'));
  assert.ok(verifyNames.includes('run_command'));
  assert.ok(!verifyNames.includes('stage_diff'), 'stage_diff must be withheld in VERIFY phase');
  assert.ok(!verifyNames.includes('apply_staged_diff'));

  // APPROVAL_GATE phase: read_file, apply_staged_diff
  const gateTools = tools.getDefinitions(HARNESS_PHASES.APPROVAL_GATE);
  const gateNames = gateTools.map(t => t.name);
  assert.ok(gateNames.includes('read_file'));
  assert.ok(gateNames.includes('apply_staged_diff'));
  assert.ok(!gateNames.includes('stage_diff'));
  assert.ok(!gateNames.includes('run_command'));
});

test('KruschTools: executeTool blocks out-of-phase invocations and missing phase options', async () => {
  const tools = new KruschTools('task_test_123', process.cwd());

  // 1. Missing options.phase is strictly blocked on phase-gated tools
  const unphasedStage = await tools.executeTool('stage_diff', { path: 'a.js', content: 'x' });
  assert.strictEqual(unphasedStage.status, 'BLOCKED');
  assert.strictEqual(unphasedStage.error, 'INVARIANT_VIOLATION');
  assert.ok(unphasedStage.message.includes('explicitly \'IMPLEMENT\''));

  const unphasedApply = await tools.executeTool('apply_staged_diff', { diffId: 42 });
  assert.strictEqual(unphasedApply.status, 'BLOCKED');
  assert.strictEqual(unphasedApply.error, 'INVARIANT_VIOLATION');
  assert.ok(unphasedApply.message.includes('explicitly \'APPROVAL_GATE\''));

  const unphasedRun = await tools.executeTool('run_command', { command: 'npm test' });
  assert.strictEqual(unphasedRun.status, 'BLOCKED');
  assert.strictEqual(unphasedRun.error, 'INVARIANT_VIOLATION');
  assert.ok(unphasedRun.message.includes('without explicit phase'));

  // 2. Out-of-phase execution
  const blockedStageInPlan = await tools.executeTool('stage_diff', { path: 'a.js', content: 'x' }, { phase: HARNESS_PHASES.PLAN });
  assert.strictEqual(blockedStageInPlan.status, 'BLOCKED');
  assert.strictEqual(blockedStageInPlan.error, 'INVARIANT_VIOLATION');
  assert.ok(blockedStageInPlan.message.includes('PLAN'));

  const blockedApplyInPlan = await tools.executeTool('apply_staged_diff', { diffId: 42 }, { phase: HARNESS_PHASES.PLAN });
  assert.strictEqual(blockedApplyInPlan.status, 'BLOCKED');
  assert.strictEqual(blockedApplyInPlan.error, 'INVARIANT_VIOLATION');
  assert.ok(blockedApplyInPlan.message.includes('PLAN'));

  const blockedStageInVerify = await tools.executeTool('stage_diff', { path: 'a.js', content: 'x' }, { phase: HARNESS_PHASES.VERIFY });
  assert.strictEqual(blockedStageInVerify.status, 'BLOCKED');
  assert.strictEqual(blockedStageInVerify.error, 'INVARIANT_VIOLATION');
  assert.ok(blockedStageInVerify.message.includes('VERIFY'));

  const blockedApplyInVerify = await tools.executeTool('apply_staged_diff', { diffId: 42 }, { phase: HARNESS_PHASES.VERIFY });
  assert.strictEqual(blockedApplyInVerify.status, 'BLOCKED');
  assert.strictEqual(blockedApplyInVerify.error, 'INVARIANT_VIOLATION');
  assert.ok(blockedApplyInVerify.message.includes('VERIFY'));

  const blockedFinishPlanInImpl = await tools.executeTool('finish_plan', {}, { phase: HARNESS_PHASES.IMPLEMENT });
  assert.strictEqual(blockedFinishPlanInImpl.status, 'BLOCKED');
  assert.strictEqual(blockedFinishPlanInImpl.error, 'INVARIANT_VIOLATION');

  const blockedReqVerifyInPlan = await tools.executeTool('request_verification', {}, { phase: HARNESS_PHASES.PLAN });
  assert.strictEqual(blockedReqVerifyInPlan.status, 'BLOCKED');
  assert.strictEqual(blockedReqVerifyInPlan.error, 'INVARIANT_VIOLATION');
});

test('Invariant Test (a): PLAN-phase adapter payload contains no apply or stage tools', async () => {
  const tools = new KruschTools('task_test_plan_payload', process.cwd());
  const planToolDefs = tools.getDefinitions(HARNESS_PHASES.PLAN);

  // Verify tool definitions list
  const toolNames = planToolDefs.map(t => t.name);
  assert.ok(!toolNames.includes('stage_diff'), 'PLAN tools must not contain stage_diff');
  assert.ok(!toolNames.includes('apply_staged_diff'), 'PLAN tools must not contain apply_staged_diff');
  assert.ok(toolNames.includes('finish_plan'), 'PLAN tools must contain finish_plan');

  // Verify adapter payload directly
  let capturedTools = null;
  const mockAdapter = {
    execute: async ({ tools: adapterTools }) => {
      capturedTools = adapterTools;
      return { text: 'Planning completed', toolCalls: [] };
    }
  };

  await mockAdapter.execute({
    modelId: 'test-model',
    messages: [{ role: 'system', content: 'You are planning.' }],
    tools: planToolDefs
  });

  assert.ok(Array.isArray(capturedTools));
  const capturedNames = capturedTools.map(t => t.name);
  assert.ok(!capturedNames.includes('stage_diff'), 'Adapter payload in PLAN phase cannot receive stage_diff');
  assert.ok(!capturedNames.includes('edit_file'), 'Adapter payload in PLAN phase cannot receive edit_file');
  assert.ok(!capturedNames.includes('apply_staged_diff'), 'Adapter payload in PLAN phase cannot receive apply_staged_diff');
  assert.deepStrictEqual(capturedNames, ['read_file', 'list_dir', 'search_symbols', 'finish_plan']);
});
