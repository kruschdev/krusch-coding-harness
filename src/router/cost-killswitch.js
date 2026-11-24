/**
 * @module router/cost-killswitch
 * Router Cost Kill-Switch Middleware (#12).
 * Tracks per-task loopDepth, cumulative spentUsd, and projectedTurnUsd,
 * falling back to $0.00 sovereign local Ollama models before breaching $0.50
 * and hard-halting paid execution at the budget or loop-depth ceiling.
 */

import { KruschTelemetry } from '../brain/telemetry.js';

/** Default per-task hard ceiling in USD ($0.50). */
export const DEFAULT_HARD_LIMIT_USD = 0.50;

/** Default $0.00 sovereign local fallback model (1st Chair, 32K ctx). */
export const DEFAULT_FALLBACK_MODEL = 'inkling-2-mini:ud-iq4_xs-dspark';

/** Default context ceiling (tokens) for local fallback turns. */
export const DEFAULT_FALLBACK_MAX_CONTEXT_TOKENS = 32768;

/** Sovereign local / mock models guaranteed to incur $0.00 API spend. */
export const LOCAL_ZERO_COST_MODELS = Object.freeze([
  'inkling-2-mini:ud-iq4_xs-dspark',
  'qwen3-coder-30b-moe:latest',
  'gemma4:e2b',
  'qwen2.5-coder:7b',
  'gemma4:e4b',
  'hermes3:latest',
  'gpt-oss:120b',
  'mock/deterministic'
]);

/**
 * Explicit per-million-token pricing for high-cost frontier models not listed in KruschTelemetry,
 * preventing underestimated fallback defaults on premium frontier IDs.
 */
const FRONTIER_PRICING_OVERRIDES = Object.freeze({
  'openai/gpt-5': { prompt: 10.0, completion: 30.0, cachedPrompt: 1.0 },
  'gpt-5': { prompt: 10.0, completion: 30.0, cachedPrompt: 1.0 },
  'openai/gpt-4.5-preview': { prompt: 75.0, completion: 150.0, cachedPrompt: 37.5 },
  'openai/o1': { prompt: 15.0, completion: 60.0, cachedPrompt: 7.5 },
  'openai/o3': { prompt: 10.0, completion: 40.0, cachedPrompt: 2.5 },
  'anthropic/claude-opus-4': { prompt: 15.0, completion: 75.0, cachedPrompt: 1.5 },
  'claude-opus-4': { prompt: 15.0, completion: 75.0, cachedPrompt: 1.5 }
});

/**
 * Router middleware enforcing loop-depth caps, soft fallback to $0.00 local models, and $0.50 hard kill-switch.
 */
export class CostKillSwitchMiddleware {
  /**
   * @param {object} [options={}] - Middleware thresholds
   * @param {number} [options.hardLimitUsd=DEFAULT_HARD_LIMIT_USD] - Hard USD ceiling per task
   * @param {number} [options.softFallbackRatio=0.80] - Fraction of hardLimitUsd triggering local fallback
   * @param {number} [options.maxLoopDepth=12] - Maximum turns allowed per task before halting
   * @param {string|null} [options.fallbackModel=DEFAULT_FALLBACK_MODEL] - Local $0.00 model ID (or null to always halt)
   * @param {number} [options.fallbackMaxContextTokens=DEFAULT_FALLBACK_MAX_CONTEXT_TOKENS] - Max total tokens permitted for local fallback
   */
  constructor({
    hardLimitUsd = DEFAULT_HARD_LIMIT_USD,
    softFallbackRatio = 0.80,
    maxLoopDepth = 12,
    fallbackModel = DEFAULT_FALLBACK_MODEL,
    fallbackMaxContextTokens = DEFAULT_FALLBACK_MAX_CONTEXT_TOKENS
  } = {}) {
    if (!Number.isFinite(hardLimitUsd) || hardLimitUsd <= 0) {
      throw new RangeError('hardLimitUsd must be a positive finite number.');
    }
    if (!Number.isFinite(softFallbackRatio) || softFallbackRatio <= 0 || softFallbackRatio > 1) {
      throw new RangeError('softFallbackRatio must be a finite number in (0, 1].');
    }
    if (!Number.isInteger(maxLoopDepth) || maxLoopDepth < 1) {
      throw new RangeError('maxLoopDepth must be a positive integer.');
    }
    if (fallbackModel !== null && (typeof fallbackModel !== 'string' || fallbackModel.trim().length === 0)) {
      throw new TypeError('fallbackModel must be a non-empty string or null.');
    }
    if (!Number.isInteger(fallbackMaxContextTokens) || fallbackMaxContextTokens < 1) {
      throw new RangeError('fallbackMaxContextTokens must be a positive integer.');
    }

    this.hardLimitUsd = hardLimitUsd;
    this.softFallbackRatio = softFallbackRatio;
    this.maxLoopDepth = maxLoopDepth;
    this.fallbackModel = fallbackModel === null ? null : fallbackModel.trim();
    this.fallbackMaxContextTokens = fallbackMaxContextTokens;
    this.ledgers = new Map();
  }

  /**
   * Retrieve or initialize the mutable internal ledger for `taskId`.
   *
   * @param {string} [taskId='default'] - Task identifier
   * @returns {{ taskId: string, loopDepth: number, spentUsd: number, history: object[] }}
   */
  _ensureLedger(taskId = 'default') {
    const key = String(taskId || 'default');
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      ledger = {
        taskId: key,
        loopDepth: 0,
        spentUsd: 0,
        history: []
      };
      this.ledgers.set(key, ledger);
    }
    return ledger;
  }

  /**
   * Estimate USD cost for a single turn, returning `0` for sovereign local/Ollama models.
   *
   * @param {string} modelId - Target model identifier
   * @param {number} [promptTokens=0] - Input token count
   * @param {number} [completionTokens=0] - Output token count
   * @param {number} [cachedPromptTokens=0] - Cached input token count
   * @returns {number} Estimated cost in USD rounded to 6 decimal places
   */
  calculateTurnCostUsd(modelId, promptTokens = 0, completionTokens = 0, cachedPromptTokens = 0) {
    if (!modelId || typeof modelId !== 'string') return 0;
    const normalized = modelId.trim();
    const lowered = normalized.toLowerCase();
    if (
      LOCAL_ZERO_COST_MODELS.includes(normalized) ||
      lowered.startsWith('ollama/') ||
      lowered.startsWith('local/') ||
      lowered.startsWith('inkling')
    ) {
      return 0;
    }

    const safePrompt = Math.max(0, Number(promptTokens) || 0);
    const safeCompletion = Math.max(0, Number(completionTokens) || 0);
    const safeCached = Math.max(0, Math.min(safePrompt, Number(cachedPromptTokens) || 0));

    const overrideRate = FRONTIER_PRICING_OVERRIDES[normalized];
    if (overrideRate) {
      const uncachedPrompt = Math.max(0, safePrompt - safeCached);
      const cachedRate =
        overrideRate.cachedPrompt !== undefined
          ? overrideRate.cachedPrompt
          : overrideRate.prompt * 0.1;
      const promptCost =
        (uncachedPrompt / 1_000_000) * overrideRate.prompt +
        (safeCached / 1_000_000) * cachedRate;
      const completionCost = (safeCompletion / 1_000_000) * overrideRate.completion;
      return Number((promptCost + completionCost).toFixed(6));
    }

    return KruschTelemetry.calculateTokenCost(normalized, safePrompt, safeCompletion, safeCached);
  }

  /**
   * Evaluate loop depth and projected turn spend prior to dispatching an LLM call.
   *
   * @param {object} [params={}] - Pre-turn evaluation input
   * @param {string} [params.taskId='default'] - Task identifier
   * @param {string} [params.modelId='gemini-4-argon'] - Requested model ID
   * @param {number} [params.promptTokens=1000] - Estimated prompt token count
   * @param {number} [params.projectedCompletionTokens=2048] - Projected completion token count
   * @param {number} [params.cachedPromptTokens=0] - Cached prompt token count
   * @param {'write'|'read_only'} [params.turnMode='write'] - Turn mutability; write turns halt and report near cap instead of downgrading
   * @param {number} [params.fallbackMaxContextTokens=this.fallbackMaxContextTokens] - Context token ceiling for local fallback
   * @returns {{ ok: boolean, tool: string, summary: string, data: object }}
   */
  evaluatePreTurn({
    taskId = 'default',
    modelId = 'gemini-4-argon',
    promptTokens = 1000,
    projectedCompletionTokens = 2048,
    cachedPromptTokens = 0,
    turnMode = 'write',
    fallbackMaxContextTokens = this.fallbackMaxContextTokens
  } = {}) {
    const ledger = this._ensureLedger(taskId);
    const nextDepth = ledger.loopDepth + 1;
    const spentUsd = Number(ledger.spentUsd.toFixed(6));
    const normalizedTurnMode =
      String(turnMode || 'write').trim().toLowerCase() === 'read_only' ? 'read_only' : 'write';
    const maxFallbackCtx = Math.max(
      1,
      Math.floor(Number(fallbackMaxContextTokens) || this.fallbackMaxContextTokens)
    );
    const projectedTotalTokens =
      Math.max(0, Number(promptTokens) || 0) + Math.max(0, Number(projectedCompletionTokens) || 0);

    if (nextDepth > this.maxLoopDepth) {
      const reason = `Loop depth ${nextDepth} exceeds maxLoopDepth (${this.maxLoopDepth}).`;
      return {
        ok: false,
        tool: 'krusch_cost_killswitch',
        summary: `Halted task ${ledger.taskId}: ${reason}`,
        data: {
          allowed: false,
          status: 'HALTED_LOOP_DEPTH',
          effectiveModel: null,
          originalModel: modelId,
          turnMode: normalizedTurnMode,
          loopDepth: nextDepth,
          spentUsd,
          projectedTurnUsd: 0,
          projectedTotalUsd: spentUsd,
          hardLimitUsd: this.hardLimitUsd,
          reason
        }
      };
    }

    if (spentUsd >= this.hardLimitUsd) {
      const reason = `Cumulative spend $${spentUsd.toFixed(6)} reached hard limit $${this.hardLimitUsd.toFixed(2)}.`;
      return {
        ok: false,
        tool: 'krusch_cost_killswitch',
        summary: `Halted task ${ledger.taskId}: ${reason}`,
        data: {
          allowed: false,
          status: 'HALTED_BUDGET_EXCEEDED',
          effectiveModel: null,
          originalModel: modelId,
          turnMode: normalizedTurnMode,
          loopDepth: nextDepth,
          spentUsd,
          projectedTurnUsd: 0,
          projectedTotalUsd: spentUsd,
          hardLimitUsd: this.hardLimitUsd,
          reason
        }
      };
    }

    const projectedTurnUsd = this.calculateTurnCostUsd(
      modelId,
      promptTokens,
      projectedCompletionTokens,
      cachedPromptTokens
    );
    const candidateTotalUsd = Number((spentUsd + projectedTurnUsd).toFixed(6));
    const softThresholdUsd = Number((this.hardLimitUsd * this.softFallbackRatio).toFixed(6));

    if (
      projectedTurnUsd > 0 &&
      (candidateTotalUsd > this.hardLimitUsd || candidateTotalUsd >= softThresholdUsd)
    ) {
      if (normalizedTurnMode !== 'read_only') {
        const reason = `Projected total $${candidateTotalUsd.toFixed(6)} crossed budget threshold on mutating write turn; halting and reporting instead of downgrading ${modelId}.`;
        return {
          ok: false,
          tool: 'krusch_cost_killswitch',
          summary: `Halted write turn for task ${ledger.taskId}: ${reason}`,
          data: {
            allowed: false,
            status: 'HALTED_BUDGET_EXCEEDED',
            reasonCode: 'WRITE_TURN_HALT_AND_REPORT',
            effectiveModel: null,
            originalModel: modelId,
            turnMode: normalizedTurnMode,
            loopDepth: nextDepth,
            spentUsd,
            projectedTurnUsd,
            projectedTotalUsd: candidateTotalUsd,
            hardLimitUsd: this.hardLimitUsd,
            reason
          }
        };
      }

      if (projectedTotalTokens > maxFallbackCtx) {
        const reason = `Projected context ${projectedTotalTokens} tokens exceeds local fallback ceiling (${maxFallbackCtx}); halting and reporting instead of truncating.`;
        return {
          ok: false,
          tool: 'krusch_cost_killswitch',
          summary: `Halted oversized read-only turn for task ${ledger.taskId}: ${reason}`,
          data: {
            allowed: false,
            status: 'HALTED_BUDGET_EXCEEDED',
            reasonCode: 'FALLBACK_CONTEXT_WINDOW_EXCEEDED',
            effectiveModel: null,
            originalModel: modelId,
            turnMode: normalizedTurnMode,
            projectedTotalTokens,
            fallbackMaxContextTokens: maxFallbackCtx,
            loopDepth: nextDepth,
            spentUsd,
            projectedTurnUsd,
            projectedTotalUsd: candidateTotalUsd,
            hardLimitUsd: this.hardLimitUsd,
            reason
          }
        };
      }

      if (!this.fallbackModel) {
        const reason = `Projected total $${candidateTotalUsd.toFixed(6)} crossed budget threshold with no fallbackModel configured.`;
        return {
          ok: false,
          tool: 'krusch_cost_killswitch',
          summary: `Halted task ${ledger.taskId}: ${reason}`,
          data: {
            allowed: false,
            status: 'HALTED_BUDGET_EXCEEDED',
            reasonCode: 'NO_FALLBACK_CONFIGURED',
            effectiveModel: null,
            originalModel: modelId,
            turnMode: normalizedTurnMode,
            loopDepth: nextDepth,
            spentUsd,
            projectedTurnUsd,
            projectedTotalUsd: candidateTotalUsd,
            hardLimitUsd: this.hardLimitUsd,
            reason
          }
        };
      }

      ledger.loopDepth = nextDepth;
      const fallbackTurnCostUsd = this.calculateTurnCostUsd(
        this.fallbackModel,
        promptTokens,
        projectedCompletionTokens,
        cachedPromptTokens
      );
      const projectedTotalUsd = Number((spentUsd + fallbackTurnCostUsd).toFixed(6));
      const reason =
        candidateTotalUsd > this.hardLimitUsd
          ? `Projected total $${candidateTotalUsd.toFixed(6)} exceeds hard limit $${this.hardLimitUsd.toFixed(2)} on read-only turn; rerouting to sovereign $0.00 fallback ${this.fallbackModel}.`
          : `Projected total $${candidateTotalUsd.toFixed(6)} reached soft threshold $${softThresholdUsd.toFixed(2)} on read-only turn; rerouting to sovereign $0.00 fallback ${this.fallbackModel}.`;

      return {
        ok: true,
        tool: 'krusch_cost_killswitch',
        summary: `Fallback triggered for task ${ledger.taskId}: ${modelId} -> ${this.fallbackModel}.`,
        data: {
          allowed: true,
          status: 'FALLBACK_MODEL',
          effectiveModel: this.fallbackModel,
          originalModel: modelId,
          turnMode: normalizedTurnMode,
          projectedTotalTokens,
          fallbackMaxContextTokens: maxFallbackCtx,
          loopDepth: nextDepth,
          spentUsd,
          projectedTurnUsd,
          projectedTotalUsd,
          hardLimitUsd: this.hardLimitUsd,
          reason
        }
      };
    }

    ledger.loopDepth = nextDepth;
    return {
      ok: true,
      tool: 'krusch_cost_killswitch',
      summary: `Turn ${nextDepth} approved on ${modelId} (projected $${projectedTurnUsd.toFixed(6)}).`,
      data: {
        allowed: true,
        status: 'PROCEED',
        effectiveModel: modelId,
        originalModel: modelId,
        turnMode: normalizedTurnMode,
        loopDepth: nextDepth,
        spentUsd,
        projectedTurnUsd,
        projectedTotalUsd: candidateTotalUsd,
        hardLimitUsd: this.hardLimitUsd,
        reason: 'Within loop depth and USD spend limits.'
      }
    };
  }

  /**
   * Record actual post-turn token usage and update cumulative task spend.
   *
   * @param {object} [params={}] - Completed turn usage
   * @returns {{ ok: boolean, tool: string, summary: string, data: object }}
   */
  recordTurnSpend({
    taskId = 'default',
    modelId,
    promptTokens = 0,
    completionTokens = 0,
    cachedPromptTokens = 0
  } = {}) {
    const ledger = this._ensureLedger(taskId);
    const turnCostUsd = this.calculateTurnCostUsd(
      modelId,
      promptTokens,
      completionTokens,
      cachedPromptTokens
    );
    ledger.spentUsd = Number((ledger.spentUsd + turnCostUsd).toFixed(6));
    const remainingUsd = Number(Math.max(0, this.hardLimitUsd - ledger.spentUsd).toFixed(6));
    const tripped = ledger.spentUsd >= this.hardLimitUsd;

    ledger.history.push({
      modelId,
      promptTokens,
      completionTokens,
      cachedPromptTokens,
      turnCostUsd,
      cumulativeSpentUsd: ledger.spentUsd,
      recordedAt: new Date().toISOString()
    });

    return {
      ok: true,
      tool: 'krusch_cost_record',
      summary: `Recorded $${turnCostUsd.toFixed(6)} for ${modelId} (spent $${ledger.spentUsd.toFixed(6)} / $${this.hardLimitUsd.toFixed(2)}).`,
      data: {
        taskId: ledger.taskId,
        turnCostUsd,
        spentUsd: ledger.spentUsd,
        remainingUsd,
        tripped
      }
    };
  }

  /**
   * Inspect the current spend and loop-depth ledger for a task.
   *
   * @param {string} [taskId='default'] - Task identifier
   * @returns {{ ok: boolean, tool: string, summary: string, data: object }}
   */
  getLedger(taskId = 'default') {
    const ledger = this._ensureLedger(taskId);
    const remainingUsd = Number(Math.max(0, this.hardLimitUsd - ledger.spentUsd).toFixed(6));
    return {
      ok: true,
      tool: 'krusch_cost_ledger',
      summary: `Task ${ledger.taskId} spent $${ledger.spentUsd.toFixed(6)} across ${ledger.loopDepth} turn(s).`,
      data: {
        taskId: ledger.taskId,
        loopDepth: ledger.loopDepth,
        spentUsd: ledger.spentUsd,
        remainingUsd,
        hardLimitUsd: this.hardLimitUsd,
        tripped: ledger.spentUsd >= this.hardLimitUsd,
        history: structuredClone(ledger.history)
      }
    };
  }

  /**
   * Reset recorded spend and loop depth for a single task (or `'*'` for all tasks).
   *
   * @param {string} [taskId='default'] - Task identifier or `'*'`
   * @returns {{ ok: boolean, tool: string, summary: string, data: { taskId: string, reset: boolean } }}
   */
  reset(taskId = 'default') {
    if (taskId === '*') {
      this.ledgers.clear();
      return {
        ok: true,
        tool: 'krusch_cost_reset',
        summary: 'Reset cost kill-switch ledgers for all tasks.',
        data: { taskId: '*', reset: true }
      };
    }

    const key = String(taskId || 'default');
    this.ledgers.delete(key);
    return {
      ok: true,
      tool: 'krusch_cost_reset',
      summary: `Reset cost kill-switch ledger for task ${key}.`,
      data: { taskId: key, reset: true }
    };
  }
}
