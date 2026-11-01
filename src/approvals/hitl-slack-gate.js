/**
 * @module approvals/hitl-slack-gate
 * Asynchronous Human-in-the-Loop (HITL) Slack approval gate (#7).
 * Drafts high-stakes actions, persists crash-safe workflow state across restarts,
 * enforces a 72-hour fail-closed TTL, and verifies Slack HMAC-SHA256 webhooks.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const webhooksBrickUrl = new URL('../../../../lib/webhooks.js', import.meta.url);
const webhooksBrickSpec = '@krusch/toolkit/webhooks';

let signWebhookHmac = null;
let verifySlackSignature = null;
let constantTimeEqual = null;

if (fs.existsSync(webhooksBrickUrl)) {
  try {
    ({ signWebhookHmac, verifySlackSignature, constantTimeEqual } = await import(webhooksBrickUrl.href));
  } catch {
    signWebhookHmac = null;
  }
}
if (!signWebhookHmac || !verifySlackSignature || !constantTimeEqual) {
  try {
    ({ signWebhookHmac, verifySlackSignature, constantTimeEqual } = await import(webhooksBrickSpec));
  } catch {
    constantTimeEqual = (a, b) => {
      const bufA = Buffer.from(String(a ?? ''), 'utf8');
      const bufB = Buffer.from(String(b ?? ''), 'utf8');
      if (bufA.length === 0 || bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    };
    signWebhookHmac = (rawBody, secret, { algorithm = 'sha256', prefix = '' } = {}) => {
      const digest = crypto.createHmac(algorithm, secret).update(String(rawBody ?? ''), 'utf8').digest('hex');
      return `${prefix}${digest}`;
    };
    verifySlackSignature = ({
      rawBody = '',
      timestampHeader,
      signatureHeader,
      signingSecret,
      toleranceSeconds = 300,
      nowSeconds = Math.floor(Date.now() / 1000)
    } = {}) => {
      if (typeof signingSecret !== 'string' || signingSecret.trim().length === 0) {
        return { ok: false };
      }
      const ts = Number(timestampHeader);
      if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > toleranceSeconds) {
        return { ok: false };
      }
      const expected = signWebhookHmac(`v0:${timestampHeader}:${rawBody ?? ''}`, signingSecret, {
        prefix: 'v0='
      });
      return { ok: constantTimeEqual(expected, signatureHeader) };
    };
  }
}

/** Default 72-hour approval time-to-live in milliseconds (259,200,000 ms). */
export const DEFAULT_HITL_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Compute a Slack v0 HMAC-SHA256 request signature.
 *
 * @param {string} signingSecret - Slack app signing secret
 * @param {number|string} timestampSec - Unix epoch timestamp in seconds
 * @param {string} rawBody - Raw unparsed HTTP request body
 * @returns {string} Formatted `v0=<hex>` Slack signature
 */
export function computeSlackSignature(signingSecret, timestampSec, rawBody) {
  if (typeof signingSecret !== 'string' || signingSecret.trim().length === 0) {
    throw new TypeError('signingSecret must be a non-empty string.');
  }
  const bodyStr = typeof rawBody === 'string' ? rawBody : String(rawBody ?? '');
  return signWebhookHmac(`v0:${timestampSec}:${bodyStr}`, signingSecret, { prefix: 'v0=' });
}

/**
 * Verify a Slack webhook HMAC-SHA256 signature with constant-time comparison and replay-skew protection.
 *
 * @param {object} params - Verification options
 * @param {string} params.signingSecret - Slack app signing secret
 * @param {string|number} params.timestampHeader - `x-slack-request-timestamp` header value
 * @param {string} params.signatureHeader - `x-slack-signature` header value
 * @param {string} [params.rawBody=''] - Raw HTTP request body
 * @param {number} [params.nowSec=Math.floor(Date.now() / 1000)] - Current Unix timestamp in seconds
 * @param {number} [params.maxSkewSec=300] - Maximum allowed clock skew in seconds
 * @returns {{ valid: boolean, reason: string }} Verification outcome
 */
export function verifySlackWebhookSignature({
  signingSecret,
  timestampHeader,
  signatureHeader,
  rawBody = '',
  nowSec = Math.floor(Date.now() / 1000),
  maxSkewSec = 300
} = {}) {
  if (typeof signingSecret !== 'string' || signingSecret.trim().length === 0) {
    return { valid: false, reason: 'Missing Slack signing secret.' };
  }
  if (timestampHeader === undefined || timestampHeader === null || timestampHeader === '') {
    return { valid: false, reason: 'Missing x-slack-request-timestamp header.' };
  }
  if (typeof signatureHeader !== 'string' || signatureHeader.trim().length === 0) {
    return { valid: false, reason: 'Missing x-slack-signature header.' };
  }

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'Invalid x-slack-request-timestamp header.' };
  }

  const skewSec = Math.abs(nowSec - ts);
  if (skewSec > maxSkewSec) {
    return {
      valid: false,
      reason: `Timestamp skew ${skewSec}s exceeds maximum allowed ${maxSkewSec}s.`
    };
  }

  const bodyStr = typeof rawBody === 'string' ? rawBody : String(rawBody ?? '');
  const expected = computeSlackSignature(signingSecret, timestampHeader, bodyStr);

  if (/^\d{1,12}$/.test(String(timestampHeader))) {
    const toolkitCheck = verifySlackSignature({
      rawBody: bodyStr,
      timestampHeader: String(timestampHeader),
      signatureHeader,
      signingSecret,
      toleranceSeconds: maxSkewSec,
      nowSeconds: nowSec
    });
    if (!toolkitCheck.ok || !constantTimeEqual(expected, signatureHeader)) {
      return { valid: false, reason: 'Slack HMAC-SHA256 signature mismatch.' };
    }
    return { valid: true, reason: 'Valid Slack HMAC-SHA256 signature.' };
  }

  if (!constantTimeEqual(expected, signatureHeader)) {
    return { valid: false, reason: 'Slack HMAC-SHA256 signature mismatch.' };
  }

  return { valid: true, reason: 'Valid Slack HMAC-SHA256 signature.' };
}

/**
 * Build a Slack Block Kit interactive message payload for a pending HITL approval gate.
 *
 * @param {object} gate - Gate record containing `gateId`, `taskId`, `actionType`, `summary`, and `expiresAt`
 * @returns {{ text: string, blocks: object[] }} Slack Block Kit message payload
 */
export function buildSlackApprovalBlocks(gate) {
  if (!gate || typeof gate !== 'object' || !gate.gateId) {
    throw new TypeError('gate object with gateId is required.');
  }
  const expiresAtIso =
    gate.expiresAt ||
    (Number.isFinite(gate.expiresAtMs) ? new Date(gate.expiresAtMs).toISOString() : 'unspecified');
  const summaryText = gate.summary || `Approval requested for ${gate.actionType}`;

  return {
    text: `HITL Approval Required: ${gate.actionType} (task ${gate.taskId})`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `HITL Approval Required: ${gate.actionType}`,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Summary:* ${summaryText}\n*Task ID:* \`${gate.taskId}\`\n*Action Type:* \`${gate.actionType}\`\n*Expires At:* \`${expiresAtIso}\``
        },
        fields: [
          { type: 'mrkdwn', text: `*Task ID:*\n\`${gate.taskId}\`` },
          { type: 'mrkdwn', text: `*Action Type:*\n\`${gate.actionType}\`` },
          { type: 'mrkdwn', text: `*Expires At:*\n\`${expiresAtIso}\`` }
        ]
      },
      {
        type: 'actions',
        block_id: `hitl_gate_${gate.gateId}`,
        elements: [
          {
            type: 'button',
            action_id: 'approve_action',
            style: 'primary',
            text: { type: 'plain_text', text: 'Approve', emoji: true },
            value: JSON.stringify({ gateId: gate.gateId, decision: 'APPROVED' })
          },
          {
            type: 'button',
            action_id: 'reject_action',
            style: 'danger',
            text: { type: 'plain_text', text: 'Reject', emoji: true },
            value: JSON.stringify({ gateId: gate.gateId, decision: 'REJECTED' })
          }
        ]
      }
    ]
  };
}

/**
 * Case-insensitively extract an HTTP header from a plain object or Fetch Headers instance.
 *
 * @param {object|Headers} headers - Incoming request headers
 * @param {string} targetName - Lowercase header name
 * @returns {string|undefined} Header value if present
 */
function readHeader(headers, targetName) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const val = headers.get(targetName);
    return val === null ? undefined : val;
  }
  const lower = targetName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Parse a Slack webhook payload from a direct object, JSON string, or URL-encoded `payload=...` body.
 *
 * @param {object|string|null} payload - Explicit payload override
 * @param {string} rawBody - Raw HTTP request body
 * @returns {{ ok: boolean, data?: { gateId: string, decision: 'APPROVED'|'REJECTED', reviewer: string, reason: string|null }, error?: string }}
 */
function parseSlackDecisionPayload(payload, rawBody) {
  let decoded = payload;

  try {
    if (decoded === null || decoded === undefined) {
      const trimmed = typeof rawBody === 'string' ? rawBody.trim() : '';
      if (!trimmed) {
        return { ok: false, error: 'Empty Slack webhook payload.' };
      }
      if (trimmed.startsWith('payload=') || (!trimmed.startsWith('{') && trimmed.includes('payload='))) {
        const params = new URLSearchParams(trimmed);
        const encodedPayload = params.get('payload');
        if (!encodedPayload) {
          return { ok: false, error: 'Missing payload parameter in form-encoded Slack body.' };
        }
        decoded = JSON.parse(encodedPayload);
      } else {
        decoded = JSON.parse(trimmed);
      }
    } else if (typeof decoded === 'string') {
      const trimmed = decoded.trim();
      if (trimmed.startsWith('payload=')) {
        const params = new URLSearchParams(trimmed);
        decoded = JSON.parse(params.get('payload') || '{}');
      } else {
        decoded = JSON.parse(trimmed);
      }
    }
  } catch (err) {
    return { ok: false, error: `Malformed Slack webhook payload: ${err.message}` };
  }

  if (!decoded || typeof decoded !== 'object') {
    return { ok: false, error: 'Parsed Slack payload must be a JSON object.' };
  }

  let gateId = decoded.gateId || null;
  let rawDecision = decoded.decision || null;

  if (Array.isArray(decoded.actions) && decoded.actions.length > 0) {
    const action = decoded.actions[0];
    if (typeof action.value === 'string' && action.value.trim().length > 0) {
      try {
        const parsedActionValue = JSON.parse(action.value);
        gateId = gateId || parsedActionValue.gateId || null;
        rawDecision = rawDecision || parsedActionValue.decision || null;
      } catch (err) {
        return { ok: false, error: `Invalid Slack button action value JSON: ${err.message}` };
      }
    }
    if (!rawDecision && action.action_id === 'approve_action') rawDecision = 'APPROVED';
    if (!rawDecision && action.action_id === 'reject_action') rawDecision = 'REJECTED';
  }

  const upperDecision = typeof rawDecision === 'string' ? rawDecision.trim().toUpperCase() : '';
  const decision =
    upperDecision === 'APPROVED' || upperDecision === 'APPROVE'
      ? 'APPROVED'
      : upperDecision === 'REJECTED' || upperDecision === 'REJECT'
        ? 'REJECTED'
        : null;

  if (!gateId || typeof gateId !== 'string') {
    return { ok: false, error: 'Missing gateId in Slack webhook payload.' };
  }
  if (!decision) {
    return { ok: false, error: `Unsupported HITL decision "${rawDecision ?? ''}".` };
  }

  const reviewer =
    decoded.reviewer ||
    decoded.user?.username ||
    decoded.user?.name ||
    decoded.user?.id ||
    'slack-reviewer';

  return {
    ok: true,
    data: {
      gateId,
      decision,
      reviewer: String(reviewer),
      reason: decoded.reason ? String(decoded.reason) : null
    }
  };
}

/**
 * Asynchronous Human-in-the-Loop Slack approval gate with crash-safe atomic JSON state persistence.
 */
export class AsyncHitlSlackGate {
  /**
   * @param {object} [options={}] - Gate configuration
   * @param {string|null} [options.stateFilePath=null] - Optional JSON file path for crash-safe persistence
   * @param {string} [options.signingSecret] - Slack HMAC signing secret
   * @param {number} [options.defaultTtlMs=DEFAULT_HITL_TTL_MS] - Default TTL in milliseconds (72h)
   */
  constructor({
    stateFilePath = null,
    signingSecret = process.env.SLACK_SIGNING_SECRET || '',
    defaultTtlMs = DEFAULT_HITL_TTL_MS
  } = {}) {
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
      throw new RangeError('defaultTtlMs must be a positive finite number.');
    }
    this.stateFilePath = stateFilePath ? path.resolve(stateFilePath) : null;
    this.signingSecret = typeof signingSecret === 'string' ? signingSecret : '';
    this.defaultTtlMs = defaultTtlMs;
    this.gates = new Map();

    if (this.stateFilePath) {
      this._loadFromDisk();
    }
  }

  /**
   * Hydrate persisted gates from disk if `stateFilePath` exists.
   */
  _loadFromDisk() {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.stateFilePath, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed?.gates) ? parsed.gates : [];
      for (const gate of records) {
        if (gate && typeof gate.gateId === 'string') {
          this.gates.set(gate.gateId, gate);
        }
      }
    } catch (err) {
      throw new Error(`Failed to hydrate HITL gate state from ${this.stateFilePath}: ${err.message}`);
    }
  }

  /**
   * Atomically persist all gate states to `stateFilePath` via `.tmp` write + `renameSync`.
   */
  _persistToDisk() {
    if (!this.stateFilePath) return;
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    const tmpPath = `${this.stateFilePath}.tmp`;
    const serialized = JSON.stringify(
      {
        version: 1,
        updatedAt: new Date().toISOString(),
        gates: Array.from(this.gates.values())
      },
      null,
      2
    );
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, this.stateFilePath);
  }

  /**
   * Draft a high-stakes action, persist its resumable snapshot, and generate Slack Block Kit blocks.
   *
   * @param {object} params - Draft parameters
   * @returns {{ ok: boolean, tool: string, summary: string, data: object }}
   */
  draftAction({
    taskId,
    actionType,
    summary,
    stagedPayload = {},
    contextSnapshot = {},
    requestedBy = 'krusch-agent',
    ttlMs = this.defaultTtlMs,
    nowMs = Date.now()
  } = {}) {
    if (taskId === undefined || taskId === null || String(taskId).trim().length === 0) {
      return {
        ok: false,
        tool: 'krusch_hitl_draft',
        summary: 'Cannot draft HITL action: taskId is required.',
        data: { gate: null, slackPayload: null }
      };
    }
    if (!actionType || typeof actionType !== 'string' || actionType.trim().length === 0) {
      return {
        ok: false,
        tool: 'krusch_hitl_draft',
        summary: 'Cannot draft HITL action: actionType is required.',
        data: { gate: null, slackPayload: null }
      };
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return {
        ok: false,
        tool: 'krusch_hitl_draft',
        summary: 'Cannot draft HITL action: ttlMs must be a positive finite number.',
        data: { gate: null, slackPayload: null }
      };
    }

    const gateId = `hitl_${crypto.randomUUID()}`;
    const expiresAtMs = nowMs + ttlMs;
    const gate = {
      gateId,
      taskId: String(taskId),
      actionType: actionType.trim(),
      summary: summary ? String(summary) : `Approval required for ${actionType.trim()}`,
      stagedPayload: structuredClone(stagedPayload ?? {}),
      contextSnapshot: structuredClone(contextSnapshot ?? {}),
      requestedBy: String(requestedBy || 'krusch-agent'),
      status: 'PENDING_APPROVAL',
      createdAtMs: nowMs,
      createdAt: new Date(nowMs).toISOString(),
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      decidedAtMs: null,
      decidedAt: null,
      reviewer: null,
      decisionReason: null,
      resumedResult: null
    };

    this.gates.set(gateId, gate);
    this._persistToDisk();

    const slackPayload = buildSlackApprovalBlocks(gate);
    return {
      ok: true,
      tool: 'krusch_hitl_draft',
      summary: `Drafted HITL gate ${gateId} for ${gate.actionType} expiring at ${gate.expiresAt}.`,
      data: {
        gate: structuredClone(gate),
        slackPayload
      }
    };
  }

  /**
   * Inspect a gate's status, auto-expiring `PENDING_APPROVAL` gates past their TTL.
   *
   * @param {string} gateId - Unique gate identifier
   * @param {object} [options={}] - Evaluation options
   * @param {number} [options.nowMs=Date.now()] - Current epoch time in milliseconds
   * @returns {{ ok: boolean, tool: string, summary: string, data: { gate: object|null } }}
   */
  getGateStatus(gateId, { nowMs = Date.now() } = {}) {
    const gate = this.gates.get(gateId);
    if (!gate) {
      return {
        ok: false,
        tool: 'krusch_hitl_status',
        summary: `HITL gate ${gateId} not found.`,
        data: { gate: null }
      };
    }

    if (gate.status === 'PENDING_APPROVAL' && nowMs > gate.expiresAtMs) {
      gate.status = 'EXPIRED';
      gate.decidedAtMs = nowMs;
      gate.decidedAt = new Date(nowMs).toISOString();
      gate.decisionReason = 'Approval TTL expired before human decision.';
      this._persistToDisk();
    }

    return {
      ok: true,
      tool: 'krusch_hitl_status',
      summary: `HITL gate ${gateId} status is ${gate.status}.`,
      data: { gate: structuredClone(gate) }
    };
  }

  /**
   * Process an incoming Slack interactive webhook, verify HMAC-SHA256, enforce 72h TTL, and resume or abort.
   *
   * @param {object} [params={}] - Webhook request details
   * @returns {Promise<{ ok: boolean, tool: string, summary: string, data: object }>}
   */
  async handleSlackWebhook({
    rawBody = '',
    payload = null,
    headers = {},
    signingSecret = this.signingSecret,
    nowMs = Date.now(),
    onResume = null
  } = {}) {
    if (typeof signingSecret !== 'string' || signingSecret.trim().length === 0) {
      return {
        ok: false,
        tool: 'krusch_hitl_webhook',
        summary: 'Slack signature verification failed: signingSecret is required.',
        data: {
          status: 'UNAUTHORIZED_SIGNATURE',
          reason: 'MISSING_SIGNING_SECRET'
        }
      };
    }

    const sigVerification = verifySlackWebhookSignature({
      signingSecret,
      timestampHeader: readHeader(headers, 'x-slack-request-timestamp'),
      signatureHeader: readHeader(headers, 'x-slack-signature'),
      rawBody,
      nowSec: Math.floor(nowMs / 1000)
    });
    if (!sigVerification.valid) {
      return {
        ok: false,
        tool: 'krusch_hitl_webhook',
        summary: `Slack signature verification failed: ${sigVerification.reason}`,
        data: {
          status: 'UNAUTHORIZED_SIGNATURE',
          reason: sigVerification.reason
        }
      };
    }

    const parsedPayload = parseSlackDecisionPayload(payload, rawBody);
    if (!parsedPayload.ok) {
      return {
        ok: false,
        tool: 'krusch_hitl_webhook',
        summary: parsedPayload.error,
        data: {
          status: 'INVALID_PAYLOAD',
          reason: parsedPayload.error
        }
      };
    }

    const { gateId, decision, reviewer, reason } = parsedPayload.data;
    const gate = this.gates.get(gateId);
    if (!gate) {
      return {
        ok: false,
        tool: 'krusch_hitl_webhook',
        summary: `Unknown HITL gate ${gateId}.`,
        data: {
          status: 'NOT_FOUND',
          gate: null,
          resumed: false,
          resumedResult: null
        }
      };
    }

    if (gate.status !== 'PENDING_APPROVAL') {
      return {
        ok: false,
        tool: 'krusch_hitl_webhook',
        summary: `HITL gate ${gateId} is already in terminal state ${gate.status}.`,
        data: {
          status: gate.status,
          alreadyDecided: true,
          gate: structuredClone(gate),
          resumed: false,
          resumedResult: gate.resumedResult
        }
      };
    }

    if (nowMs > gate.expiresAtMs) {
      gate.status = 'EXPIRED';
      gate.decidedAtMs = nowMs;
      gate.decidedAt = new Date(nowMs).toISOString();
      gate.decisionReason = 'Approval TTL expired before webhook arrived.';
      this._persistToDisk();

      return {
        ok: false,
        tool: 'krusch_hitl_webhook',
        summary: `HITL gate ${gateId} expired at ${gate.expiresAt}; failing closed.`,
        data: {
          status: 'EXPIRED',
          gate: structuredClone(gate),
          resumed: false,
          resumedResult: null
        }
      };
    }

    gate.status = decision;
    gate.decidedAtMs = nowMs;
    gate.decidedAt = new Date(nowMs).toISOString();
    gate.reviewer = reviewer;
    gate.decisionReason = reason;
    this._persistToDisk();

    let resumed = false;
    let resumedResult = null;
    if (decision === 'APPROVED' && typeof onResume === 'function') {
      try {
        resumedResult = await onResume(structuredClone(gate));
        resumed = true;
        gate.resumedResult = resumedResult;
        this._persistToDisk();
      } catch (err) {
        gate.resumeError = err?.message || String(err);
        this._persistToDisk();
        return {
          ok: false,
          tool: 'krusch_hitl_webhook',
          summary: `HITL gate ${gateId} approved, but resume callback failed: ${gate.resumeError}`,
          data: {
            status: 'RESUME_FAILED',
            gate: structuredClone(gate),
            resumed: false,
            resumedResult: null,
            reason: gate.resumeError
          }
        };
      }
    }

    return {
      ok: true,
      tool: 'krusch_hitl_webhook',
      summary: `HITL gate ${gateId} ${decision.toLowerCase()} by ${reviewer}.`,
      data: {
        status: gate.status,
        gate: structuredClone(gate),
        resumed,
        resumedResult
      }
    };
  }

  /**
   * Sweep all pending gates and transition expired entries to `EXPIRED` (fail-closed).
   *
   * @param {object} [options={}] - Sweep options
   * @param {number} [options.nowMs=Date.now()] - Current epoch time in milliseconds
   * @returns {{ ok: boolean, tool: string, summary: string, data: { expiredCount: number, expiredGateIds: string[] } }}
   */
  sweepExpiredGates({ nowMs = Date.now() } = {}) {
    const expiredGateIds = [];

    for (const gate of this.gates.values()) {
      if (gate.status === 'PENDING_APPROVAL' && nowMs > gate.expiresAtMs) {
        gate.status = 'EXPIRED';
        gate.decidedAtMs = nowMs;
        gate.decidedAt = new Date(nowMs).toISOString();
        gate.decisionReason = 'Expired during scheduled HITL TTL sweep.';
        expiredGateIds.push(gate.gateId);
      }
    }

    if (expiredGateIds.length > 0) {
      this._persistToDisk();
    }

    return {
      ok: true,
      tool: 'krusch_hitl_sweep',
      summary: `Swept ${expiredGateIds.length} expired HITL gate(s).`,
      data: {
        expiredCount: expiredGateIds.length,
        expiredGateIds
      }
    };
  }
}
