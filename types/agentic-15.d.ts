/**
 * Type declarations for krusch-coding-harness v0.2.0 subpath exports:
 * - krusch-coding-harness/hitl
 * - krusch-coding-harness/cost-killswitch
 * - krusch-coding-harness/browser-fallback
 * - krusch-coding-harness/trajectory-eval
 */

export interface KruschEnvelope<T = Record<string, any>> {
  ok: boolean;
  tool: string;
  summary: string;
  data: T;
}

export const DEFAULT_HITL_TTL_MS: number;
export function computeSlackSignature(
  signingSecret: string,
  timestampSec: number | string,
  rawBody: string
): string;
export function verifySlackWebhookSignature(params: {
  signingSecret: string;
  timestampHeader: string | number;
  signatureHeader: string;
  rawBody?: string;
  nowSec?: number;
  maxSkewSec?: number;
}): { valid: boolean; reason: string };
export function buildSlackApprovalBlocks(gate: Record<string, any>): Record<string, any>;

export class AsyncHitlSlackGate {
  constructor(options?: {
    stateFilePath?: string | null;
    signingSecret?: string;
    defaultTtlMs?: number;
  });
  draftAction(params: {
    taskId: string;
    actionType: string;
    summary: string;
    stagedPayload?: Record<string, any>;
    contextSnapshot?: Record<string, any>;
    requestedBy?: string;
    ttlMs?: number;
    nowMs?: number;
  }): KruschEnvelope;
  getGateStatus(gateId: string, options?: { nowMs?: number }): KruschEnvelope;
  handleSlackWebhook(params: {
    rawBody?: string;
    payload?: any;
    headers?: Record<string, any>;
    signingSecret?: string;
    nowMs?: number;
    onResume?: ((gate: Record<string, any>) => Promise<any> | any) | null;
  }): Promise<KruschEnvelope>;
  sweepExpiredGates(options?: { nowMs?: number }): KruschEnvelope;
}

export const DEFAULT_HARD_LIMIT_USD: number;
export const DEFAULT_FALLBACK_MODEL: string;
export const DEFAULT_FALLBACK_MAX_CONTEXT_TOKENS: number;
export const LOCAL_ZERO_COST_MODELS: readonly string[];

export class CostKillSwitchMiddleware {
  constructor(options?: {
    hardLimitUsd?: number;
    softFallbackRatio?: number;
    maxLoopDepth?: number;
    fallbackModel?: string | null;
    fallbackMaxContextTokens?: number;
  });
  calculateTurnCostUsd(
    modelId: string,
    promptTokens?: number,
    completionTokens?: number,
    cachedPromptTokens?: number
  ): number;
  evaluatePreTurn(params?: {
    taskId?: string;
    modelId?: string;
    promptTokens?: number;
    projectedCompletionTokens?: number;
    cachedPromptTokens?: number;
    turnMode?: 'write' | 'read_only';
    fallbackMaxContextTokens?: number;
  }): KruschEnvelope;
  recordTurnSpend(params: {
    taskId?: string;
    modelId: string;
    promptTokens?: number;
    completionTokens?: number;
    cachedPromptTokens?: number;
  }): KruschEnvelope;
  getLedger(taskId?: string): KruschEnvelope;
  reset(taskId?: string): KruschEnvelope;
}

export const FALLBACK_HTTP_STATUSES: readonly number[];
export function isSafeHttpUrl(
  rawUrl: string,
  options?: { allowLoopback?: boolean }
): { safe: boolean; reason: string | null };

export class ApiToBrowserFallbackAgent {
  constructor(options?: {
    fetchImpl?: typeof fetch;
    browserDriver?: ((workflow: Record<string, any>) => Promise<any>) | null;
    apiTimeoutMs?: number;
    allowLoopback?: boolean;
  });
  execute(params: {
    actionName?: string;
    apiRequest: Record<string, any>;
    guiWorkflow?: Record<string, any>;
    fallbackOnAuthError?: boolean;
  }): Promise<KruschEnvelope>;
}

export const DEFAULT_GOLDEN_FIXTURE_PATH: string;
export function evaluateSingleTrajectoryDag(trajectory: Record<string, any>): {
  id: string;
  category: string;
  passed: boolean;
  stepCount: number;
  executedTools: string[];
  violations: Array<{ rule: string; message: string; [key: string]: any }>;
};
export function runTrajectoryEvalGate(options?: {
  fixturePath?: string;
  trajectories?: Array<Record<string, any>> | null;
  minRequiredCount?: number;
}): KruschEnvelope<{
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  minRequiredCount: number;
  categories: Record<string, any>;
  failures: Array<Record<string, any>>;
  results: Array<Record<string, any>>;
}>;
