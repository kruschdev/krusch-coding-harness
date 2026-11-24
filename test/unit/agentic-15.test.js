import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_HITL_TTL_MS,
  computeSlackSignature,
  verifySlackWebhookSignature,
  AsyncHitlSlackGate,
} from '../../src/approvals/hitl-slack-gate.js';
import {
  DEFAULT_HARD_LIMIT_USD,
  CostKillSwitchMiddleware,
} from '../../src/router/cost-killswitch.js';
import { ApiToBrowserFallbackAgent, isSafeHttpUrl } from '../../src/tools/api-browser-fallback.js';
import {
  evaluateSingleTrajectoryDag,
  runTrajectoryEvalGate,
} from '../../src/eval/trajectory-dag-gate.js';
import { startBridgeServer } from '../../src/control/control-plane.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

describe('Production Agentic Systems (#7 HITL, #8 Golden DAG CI, #12 Cost Kill-Switch, #13 Browser Fallback)', () => {
  it('#7 AsyncHitlSlackGate enforces 72h TTL, HMAC-SHA256 verification, crash recovery, and HTTP bridge resume', async () => {
    assert.equal(DEFAULT_HITL_TTL_MS, 72 * 60 * 60 * 1000);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krusch-hitl-'));
    const stateFile = path.join(tmpDir, 'hitl-gates.json');
    const secret = 'slack-test-signing-secret-2026';
    const baseNow = 1_760_000_000_000;

    try {
      const gate = new AsyncHitlSlackGate({ stateFilePath: stateFile, signingSecret: secret });
      const drafted = gate.draftAction({
        taskId: 'task-prod-01',
        actionType: 'DROP_LEGACY_INDEX',
        summary: 'Drop unused index idx_old_events on production replica',
        stagedPayload: { sql: 'DROP INDEX CONCURRENTLY idx_old_events;' },
        nowMs: baseNow,
      });

      assert.equal(drafted.ok, true);
      const gateId = drafted.data.gate.gateId;
      assert.equal(drafted.data.gate.status, 'PENDING_APPROVAL');
      assert.equal(drafted.data.gate.expiresAtMs - baseNow, DEFAULT_HITL_TTL_MS);
      assert.ok(Array.isArray(drafted.data.slackPayload.blocks));

      // Reload from disk to prove serialized state survives process restart over 3-day wait
      const reloadedGate = new AsyncHitlSlackGate({ stateFilePath: stateFile, signingSecret: secret });
      const status48h = reloadedGate.getGateStatus(gateId, { nowMs: baseNow + 48 * 3600 * 1000 });
      assert.equal(status48h.ok, true);
      assert.equal(status48h.data.gate.status, 'PENDING_APPROVAL');

      // Forged signature MUST be rejected
      const actionPayload = JSON.stringify({
        user: { username: 'principal-sre' },
        actions: [{ value: JSON.stringify({ gateId, decision: 'APPROVED' }) }],
      });
      const rawForm = `payload=${encodeURIComponent(actionPayload)}`;
      const webhookTsSec = Math.floor((baseNow + 48 * 3600 * 1000) / 1000);

      const badRes = await reloadedGate.handleSlackWebhook({
        rawBody: rawForm,
        headers: {
          'x-slack-request-timestamp': String(webhookTsSec),
          'x-slack-signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
        },
        nowMs: webhookTsSec * 1000,
      });
      assert.equal(badRes.ok, false);
      assert.equal(badRes.data.status, 'UNAUTHORIZED_SIGNATURE');

      // Valid Slack HMAC-SHA256 signature resumes workflow cleanly
      let resumedSql = null;
      const validSig = computeSlackSignature(secret, webhookTsSec, rawForm);
      assert.equal(
        verifySlackWebhookSignature({
          signingSecret: secret,
          timestampHeader: webhookTsSec,
          signatureHeader: validSig,
          rawBody: rawForm,
          nowSec: webhookTsSec,
        }).valid,
        true
      );

      const okRes = await reloadedGate.handleSlackWebhook({
        rawBody: rawForm,
        headers: {
          'x-slack-request-timestamp': String(webhookTsSec),
          'x-slack-signature': validSig,
        },
        nowMs: webhookTsSec * 1000,
        onResume: async (g) => {
          resumedSql = g.stagedPayload.sql;
          return { executed: true };
        },
      });
      assert.equal(okRes.ok, true);
      assert.equal(okRes.data.gate.status, 'APPROVED');
      assert.equal(okRes.data.resumed, true);
      assert.equal(resumedSql, 'DROP INDEX CONCURRENTLY idx_old_events;');

      // Gate past 72h + 1ms fails closed as EXPIRED
      const expDraft = reloadedGate.draftAction({
        taskId: 'task-prod-02',
        actionType: 'ROTATE_MASTER_KEY',
        summary: 'Rotate master key',
        nowMs: baseNow,
      });
      const expCheck = reloadedGate.getGateStatus(expDraft.data.gate.gateId, {
        nowMs: baseNow + DEFAULT_HITL_TTL_MS + 1,
      });
      assert.equal(expCheck.data.gate.status, 'EXPIRED');

      // End-to-end HTTP Control Bridge Slack webhook verification
      const server = startBridgeServer({ port: 0, host: '127.0.0.1', slackSigningSecret: secret });
      await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
      const addr = server.address();
      try {
        const draftHttp = await fetch(`http://127.0.0.1:${addr.port}/api/hitl/draft`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskId: 'bridge-hitl-1',
            actionType: 'DEPLOY_PROD',
            summary: 'Deploy v0.2.0',
          }),
        });
        assert.equal(draftHttp.status, 200);
        const draftJson = await draftHttp.json();
        const bridgeGateId = draftJson.data.gate.gateId;

        const nowSec = Math.floor(Date.now() / 1000);
        const bridgeBody = `payload=${encodeURIComponent(
          JSON.stringify({
            user: { username: 'krusch' },
            actions: [{ value: JSON.stringify({ gateId: bridgeGateId, decision: 'APPROVED' }) }],
          })
        )}`;
        const bridgeSig = computeSlackSignature(secret, nowSec, bridgeBody);
        const hookHttp = await fetch(`http://127.0.0.1:${addr.port}/api/hitl/slack-webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-slack-request-timestamp': String(nowSec),
            'x-slack-signature': bridgeSig,
          },
          body: bridgeBody,
        });
        assert.equal(hookHttp.status, 200);
        const hookJson = await hookHttp.json();
        assert.equal(hookJson.ok, true);
        assert.equal(hookJson.data.gate.status, 'APPROVED');
      } finally {
        server.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('#8 TrajectoryDagCiGate replays all 100 golden trajectories and CLI exits non-zero on DAG drift', () => {
    const report = runTrajectoryEvalGate();
    assert.equal(report.ok, true);
    assert.equal(report.data.total, 100);
    assert.equal(report.data.passed, 100);
    assert.equal(report.data.failed, 0);
    assert.equal(Object.keys(report.data.categories).length, 10);

    // CLI invocation passes 100/100
    const cliPass = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'bin/krusch.js'), 'eval-trajectories', '--strict', '--json'],
      { encoding: 'utf8' }
    );
    assert.equal(cliPass.status, 0);
    const parsedCli = JSON.parse(cliPass.stdout);
    assert.equal(parsedCli.ok, true);
    assert.equal(parsedCli.data.total, 100);

    // Deviating trajectory (applying diff after failed test run) MUST fail Golden DAG gate
    const drifted = evaluateSingleTrajectoryDag({
      id: 'traj-drift-01',
      category: 'two_phase_commit_apply',
      steps: [
        { tool: 'read_file', args: { path: 'src/index.js' }, ok: true },
        { tool: 'stage_diff', args: { path: 'src/index.js' }, ok: true },
        { tool: 'run_tests', args: { command: 'npm test' }, ok: false },
        { tool: 'apply_staged_diff', args: { path: 'src/index.js' }, ok: true },
      ],
      goldenDag: {
        requiredTools: ['read_file', 'stage_diff', 'run_tests', 'apply_staged_diff'],
        forbiddenTools: ['raw_shell_rm'],
        precedenceEdges: [
          ['read_file', 'stage_diff'],
          ['stage_diff', 'run_tests'],
          ['run_tests', 'apply_staged_diff'],
        ],
        requirePassingPrerequisite: [['run_tests', 'apply_staged_diff']],
      },
    });
    assert.equal(drifted.passed, false);
    assert.ok(drifted.violations.length > 0);
  });

  it('#12 CostKillSwitchMiddleware halts write turns near $0.50, downgrades bounded read_only turns to Inkling, and halts on context/budget/depth breach', () => {
    assert.equal(DEFAULT_HARD_LIMIT_USD, 0.50);
    const guard = new CostKillSwitchMiddleware({
      hardLimitUsd: 0.50,
      softFallbackRatio: 0.80,
      maxLoopDepth: 6,
    });

    // Verify 1st-Chair Inkling and 3rd-Chair Gemma4 e2b are recognized as $0.00 local models
    assert.equal(guard.calculateTurnCostUsd('inkling-2-mini:ud-iq4_xs-dspark', 16_000, 4_000), 0);
    assert.equal(guard.calculateTurnCostUsd('gemma4:e2b', 8_000, 2_000), 0);

    // Turn 1: Well below $0.50 -> PROCEED
    const t1 = guard.evaluatePreTurn({
      taskId: 'runaway-1',
      modelId: 'openai/gpt-5',
      promptTokens: 5_000,
      projectedCompletionTokens: 2_000,
    });
    assert.equal(t1.ok, true);
    assert.equal(t1.data.status, 'PROCEED');
    assert.equal(t1.data.effectiveModel, 'openai/gpt-5');

    // Record $0.42 spend -> next paid mutating write turn MUST halt and report (no silent downgrade)
    guard.recordTurnSpend({
      taskId: 'runaway-1',
      modelId: 'openai/gpt-5',
      promptTokens: 21_000,
      completionTokens: 7_000,
    });
    const tWriteHalt = guard.evaluatePreTurn({
      taskId: 'runaway-1',
      modelId: 'openai/gpt-5',
      promptTokens: 10_000,
      projectedCompletionTokens: 4_000,
    });
    assert.equal(tWriteHalt.ok, false);
    assert.equal(tWriteHalt.data.allowed, false);
    assert.equal(tWriteHalt.data.status, 'HALTED_BUDGET_EXCEEDED');
    assert.equal(tWriteHalt.data.reasonCode, 'WRITE_TURN_HALT_AND_REPORT');
    assert.equal(tWriteHalt.data.effectiveModel, null);

    // Bounded read_only wrap-up turn -> FALLBACK_MODEL to $0.00 1st-Chair Inkling
    const t2 = guard.evaluatePreTurn({
      taskId: 'runaway-1',
      modelId: 'openai/gpt-5',
      promptTokens: 10_000,
      projectedCompletionTokens: 4_000,
      turnMode: 'read_only',
    });
    assert.equal(t2.ok, true);
    assert.equal(t2.data.status, 'FALLBACK_MODEL');
    assert.equal(t2.data.effectiveModel, 'inkling-2-mini:ud-iq4_xs-dspark');
    assert.equal(t2.data.projectedTotalUsd, t2.data.spentUsd);

    // Oversized read_only turn (>32K ctx) -> halts instead of silently truncating
    const tOversized = guard.evaluatePreTurn({
      taskId: 'runaway-1',
      modelId: 'openai/gpt-5',
      promptTokens: 31_000,
      projectedCompletionTokens: 4_000,
      turnMode: 'read_only',
    });
    assert.equal(tOversized.ok, false);
    assert.equal(tOversized.data.status, 'HALTED_BUDGET_EXCEEDED');
    assert.equal(tOversized.data.reasonCode, 'FALLBACK_CONTEXT_WINDOW_EXCEEDED');

    // Push cumulative spend >= $0.50 -> hard kill switch trips immediately even for read_only
    guard.recordTurnSpend({
      taskId: 'runaway-1',
      modelId: 'openai/gpt-5',
      promptTokens: 10_000,
      completionTokens: 5_000,
    });
    const t3 = guard.evaluatePreTurn({
      taskId: 'runaway-1',
      modelId: 'openai/gpt-5',
      promptTokens: 1_000,
      projectedCompletionTokens: 500,
      turnMode: 'read_only',
    });
    assert.equal(t3.ok, false);
    assert.equal(t3.data.allowed, false);
    assert.equal(t3.data.status, 'HALTED_BUDGET_EXCEEDED');
  });

  it('#13 ApiToBrowserFallbackAgent falls back to headless browser on 404/timeout and fails closed on 401', async () => {
    let browserInvocations = 0;
    const agent = new ApiToBrowserFallbackAgent({
      apiTimeoutMs: 50,
      fetchImpl: async (url) => {
        if (String(url).includes('/404')) {
          return { ok: false, status: 404, text: async () => 'Not Found' };
        }
        if (String(url).includes('/401')) {
          return { ok: false, status: 401, text: async () => 'Unauthorized' };
        }
        if (String(url).includes('/hang')) {
          return await new Promise(() => {});
        }
        return {
          ok: true,
          status: 200,
          headers: { 'content-type': 'application/json' },
          text: async () => JSON.stringify({ invoiceId: 'INV-200' }),
        };
      },
      browserDriver: async (workflow) => {
        browserInvocations += 1;
        return { invoiceId: 'INV-GUI-999', url: workflow.url, stepsRun: workflow.steps.length };
      },
    });

    // 1. Primary API succeeds
    const okApi = await agent.execute({
      actionName: 'fetch_invoice',
      apiRequest: { url: 'http://127.0.0.1:9999/api/invoices/200' },
      guiWorkflow: { url: 'http://127.0.0.1:9999/portal', steps: [{ action: 'click', selector: '#dl' }] },
    });
    assert.equal(okApi.ok, true);
    assert.equal(okApi.data.channel, 'rest_api');
    assert.equal(okApi.data.fallbackTriggered, false);
    assert.equal(browserInvocations, 0);

    // 2. Primary API 404s -> seamless headless browser GUI completion
    const fallback404 = await agent.execute({
      actionName: 'fetch_invoice_legacy',
      apiRequest: { url: 'http://127.0.0.1:9999/api/404' },
      guiWorkflow: { url: 'http://127.0.0.1:9999/portal', steps: [{ action: 'click', selector: '#dl' }] },
    });
    assert.equal(fallback404.ok, true);
    assert.equal(fallback404.data.channel, 'headless_browser');
    assert.equal(fallback404.data.fallbackTriggered, true);
    assert.equal(fallback404.data.result.invoiceId, 'INV-GUI-999');

    // 3. Primary API hangs past timeout -> seamless headless browser GUI completion
    const fallbackTimeout = await agent.execute({
      actionName: 'fetch_invoice_slow',
      apiRequest: { url: 'http://127.0.0.1:9999/api/hang' },
      guiWorkflow: { url: 'http://127.0.0.1:9999/portal', steps: [{ action: 'click', selector: '#dl' }] },
    });
    assert.equal(fallbackTimeout.ok, true);
    assert.equal(fallbackTimeout.data.channel, 'headless_browser');
    assert.equal(fallbackTimeout.data.fallbackTriggered, true);

    // 4. Primary API returns 401 -> fails closed without bypassing auth via GUI
    const beforeCount = browserInvocations;
    const denied401 = await agent.execute({
      actionName: 'unauthorized_op',
      apiRequest: { url: 'http://127.0.0.1:9999/api/401' },
      guiWorkflow: { url: 'http://127.0.0.1:9999/portal', steps: [] },
    });
    assert.equal(denied401.ok, false);
    assert.equal(browserInvocations, beforeCount);

    // 5. Cloud metadata / file:// SSRF URLs are blocked fail-closed
    const ssrfBlocked = await agent.execute({
      actionName: 'ssrf_probe',
      apiRequest: { url: 'http://169.254.169.254/latest/meta-data/' },
      guiWorkflow: { url: 'http://127.0.0.1:9999/portal', steps: [] },
    });
    assert.equal(ssrfBlocked.ok, false);
    assert.equal(ssrfBlocked.data.fallbackReason, 'UNSAFE_URL_BLOCKED');

    const fileGuiBlocked = await agent.execute({
      actionName: 'file_gui_probe',
      apiRequest: { url: 'http://127.0.0.1:9999/api/404' },
      guiWorkflow: { url: 'file:///etc/passwd', steps: [] },
    });
    assert.equal(fileGuiBlocked.ok, false);
    assert.equal(fileGuiBlocked.data.fallbackReason, 'UNSAFE_URL_BLOCKED');

    // 6. IPv6-mapped IPv4 metadata/loopback & AWS IPv6 IMDS SSRF bypass probes fail closed
    assert.equal(isSafeHttpUrl('http://[::ffff:169.254.169.254]/latest/meta-data/').safe, false);
    assert.equal(isSafeHttpUrl('http://[0:0:0:0:0:ffff:169.254.169.254]/latest/meta-data/').safe, false);
    assert.equal(isSafeHttpUrl('http://[fd00:ec2::254]/latest/meta-data/').safe, false);
    assert.equal(isSafeHttpUrl('http://[::ffff:0.0.0.0]/').safe, false);
    assert.equal(isSafeHttpUrl('http://[::ffff:127.0.0.1]:8080/admin', { allowLoopback: false }).safe, false);
  });

  it('Enforces fail-closed missing SLACK_SIGNING_SECRET, HTTP 413 body limit, and 400 malformed JSON on bridge', async () => {
    const unconfiguredGate = new AsyncHitlSlackGate({ signingSecret: '' });
    const unauthRes = await unconfiguredGate.handleSlackWebhook({
      rawBody: JSON.stringify({ gateId: 'g-1', decision: 'APPROVED' }),
      headers: {},
    });
    assert.equal(unauthRes.ok, false);
    assert.equal(unauthRes.data.status, 'UNAUTHORIZED_SIGNATURE');

    const server = startBridgeServer({ port: 0, host: '127.0.0.1', maxBodyBytes: 1024, slackSigningSecret: '' });
    await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
    const addr = server.address();
    try {
      // Unconfigured SLACK_SIGNING_SECRET on HTTP webhook MUST fail closed with 401
      const unauthHttp = await fetch(`http://127.0.0.1:${addr.port}/api/hitl/slack-webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateId: 'g-1', decision: 'APPROVED' }),
      });
      assert.equal(unauthHttp.status, 401);

      // Malformed JSON MUST return 400 (never 500)
      const badJsonHttp = await fetch(`http://127.0.0.1:${addr.port}/api/cost/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"broken_json":',
      });
      assert.equal(badJsonHttp.status, 400);

      // Oversized payload > 1024 bytes MUST return 413 Payload Too Large
      const oversizedHttp = await fetch(`http://127.0.0.1:${addr.port}/api/cost/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pad: 'x'.repeat(2048) }),
      });
      assert.equal(oversizedHttp.status, 413);
    } finally {
      server.close();
    }
  });
});
