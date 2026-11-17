/**
 * Type declarations for krusch-coding-harness (v0.1.0) — Krusch Coding Harness.
 * Postgres-backed coding harness that stages diffs, runs tests, and only then writes the working tree.
 */

export interface TaskRecord {
  id: string;
  goal: string;
  project_path: string;
  phase: HarnessPhase;
  current_model: string | null;
  metadata: Record<string, any>;
  verification_command?: string | null;
  budget_turns?: number;
  budget_tokens?: number;
  max_phase_revisits?: number;
  used_turns?: number;
  used_tokens?: number;
  phase_revisits?: Record<string, number>;
  created_at: string;
  updated_at: string;
  turns?: TurnRecord[];
  stagedDiffs?: StagedDiffRecord[];
  approvals?: ApprovalRecord[];
  verifications?: VerificationRunRecord[];
}

export type HarnessPhase =
  | 'INIT'
  | 'PLAN'
  | 'IMPLEMENT'
  | 'VERIFY'
  | 'APPROVAL_GATE'
  | 'COMMITTED'
  | 'ABORTED';

export const HARNESS_PHASES: Record<HarnessPhase, HarnessPhase>;

export interface TurnRecord {
  id: number;
  task_id: string;
  turn_number: number;
  model_id: string;
  input_messages: any[];
  output_text: string | null;
  thought_trace: string | null;
  token_usage: Record<string, any>;
  latency_ms: number | null;
  routing_stage: string | null;
  created_at: string;
}

export interface StagedDiffRecord {
  id: number;
  task_id: string;
  project_path?: string;
  file_path: string;
  original_content: string | null;
  staged_content: string;
  diff_patch: string | null;
  status: 'PENDING' | 'APPLYING' | 'APPLIED' | 'COMMITTED' | 'REJECTED';
  sha256_hash: string;
  original_sha256: string | null;
  lease_expires_at?: string | null;
  created_at: string;
  applied_at: string | null;
}

export interface KruschPhaseEdge {
  from_phase: HarnessPhase;
  to_phase: HarnessPhase;
}

export interface ApprovalRecord {
  id: number;
  task_id: string;
  action_type: string;
  target_resource: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'AUTO_BYPASSED';
  requested_by_model: string | null;
  decision_reason: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface VerificationRunRecord {
  id: number;
  task_id: string;
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  failure_module: string | null;
  extracted_errors: any[];
  sandbox_type?: string | null;
  replay_token?: string | null;
  sandbox_config?: any;
  env_snapshot?: any;
  file_manifest?: any;
  created_at: string;
  duration_ms?: number;
}

export interface KruschBlobRecord {
  sha256: string;
  content: string;
  byte_size: number;
  created_at: string;
}

export interface TaskSymbolRecord {
  id: number;
  task_id: string;
  file_path: string;
  symbol_name: string;
  symbol_type?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  signature?: string | null;
  created_at: string;
}

export function cleanOrphanedTempFiles(fullPath: string, fsOps?: any, options?: { throwOnIoError?: boolean }): void;
export function fsyncDirectory(dirPath: string, fsOps?: any): void;
export function atomicWriteFile(targetPath: string, content: string | Buffer | Uint8Array, fsOps?: any): void;
export function canonicalizePaths(projectPath: string, filePath: string): { projectPath: string; filePath: string };

export class KruschFSM {
  taskId: string;
  currentPhase: HarnessPhase;
  constructor(taskId: string, initialPhase?: HarnessPhase);
  static loadAllowedTransitions(client?: any): Promise<Record<HarnessPhase, HarnessPhase[]>>;
  static getAllowedTransitions(): Record<HarnessPhase, HarnessPhase[]>;
  syncPhase(): Promise<HarnessPhase>;
  canTransitionTo(targetPhase: HarnessPhase, fromPhase?: HarnessPhase | null): boolean;
  transitionTo(targetPhase: HarnessPhase, metadata?: Record<string, any>): Promise<{ from: HarnessPhase; to: HarnessPhase }>;
}

export class KruschStateManager {
  static createTask(params: {
    id?: string;
    goal: string;
    projectPath: string;
    phase?: HarnessPhase;
    currentModel?: string | null;
    metadata?: Record<string, any>;
    verificationCommand?: string | null;
  }): Promise<TaskRecord>;

  static updateTask(
    taskId: string,
    params: { phase?: HarnessPhase; currentModel?: string; metadata?: Record<string, any> }
  ): Promise<TaskRecord>;

  static getTask(taskId: string): Promise<TaskRecord | null>;

  static recordTurn(
    taskId: string,
    turn: {
      turnNumber: number;
      modelId: string;
      inputMessages: any[];
      outputText?: string | null;
      thoughtTrace?: string | null;
      tokenUsage?: Record<string, any>;
      latencyMs?: number | null;
      routingStage?: string;
    }
  ): Promise<TurnRecord>;

  static recordEvent(taskId: string, turnId: number | null, eventType: string, payload: any): Promise<any>;

  static stageDiff(
    taskId: string,
    diff: {
      filePath: string;
      originalContent?: string | null;
      stagedContent: string;
      diffPatch?: string;
      projectPath?: string;
    }
  ): Promise<StagedDiffRecord>;

  static pruneExpiredLeases(): Promise<any[]>;

  static releaseLease(taskId: string, filePath: string, projectPath?: string | null): Promise<StagedDiffRecord | null>;

  static listActiveLeases(projectPath?: string | null): Promise<any[]>;

  static recoverInFlightApplies(projectPath?: string | null, options?: Record<string, any>): Promise<any[]>;

  static applyDiffBatch(
    taskId: string,
    diffIds?: number[] | null,
    projectPath?: string | null,
    options?: Record<string, any>
  ): Promise<{
    status: string;
    appliedCount: number;
    journalId?: number;
    message?: string;
    diffs?: Array<{ id: number; filePath: string }>;
  }>;

  static explainTaskStatus(taskId: string): Promise<any>;

  static formatExplainOutput(explanation: any): string;

  static getPendingDiffs(taskId: string): Promise<StagedDiffRecord[]>;

  static getStagedDiffs(taskId: string): Promise<StagedDiffRecord[]>;

  static getActiveDiffs(taskId: string): Promise<StagedDiffRecord[]>;

  static updateDiffStatus(diffId: number, status: 'PENDING' | 'APPLYING' | 'APPLIED' | 'COMMITTED' | 'REJECTED'): Promise<StagedDiffRecord>;

  static requestApproval(
    taskId: string,
    approval: {
      actionType: string;
      targetResource: string;
      requestedByModel?: string;
      status?: string;
      decisionReason?: string | null;
    }
  ): Promise<ApprovalRecord>;

  static decideApproval(approvalId: number, status: string, decisionReason?: string): Promise<ApprovalRecord>;

  static recordVerificationRun(
    taskId: string,
    run: {
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      passed: boolean;
      failureModule?: string | null;
      extractedErrors?: any[];
    },
    client?: any
  ): Promise<VerificationRunRecord>;

  static recordVerificationAndTransition(
    taskId: string,
    verifData: {
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      passed: boolean;
      failureModule?: string | null;
      extractedErrors?: any[];
    },
    targetPhase?: HarnessPhase | null,
    metadata?: Record<string, any>
  ): Promise<{ verificationRun: VerificationRunRecord; transition: any }>;

  static getLatestVerificationRun(taskId: string, client?: any): Promise<VerificationRunRecord | null>;

  static hasUnappliedStagedDiffs(taskId: string, client?: any): Promise<boolean>;

  static hasAnyStagedDiffs(taskId: string, client?: any): Promise<boolean>;

  static atomicTransitionPhase(
    taskId: string,
    targetPhase: HarnessPhase,
    allowedSourcePhases?: HarnessPhase[],
    guardValidator?: (ctx: { task: TaskRecord; client: any; targetPhase: HarnessPhase }) => Promise<void>,
    metadata?: Record<string, any>
  ): Promise<{ from: HarnessPhase; to: HarnessPhase; task: TaskRecord }>;

  static abortTask(taskId: string, reason?: string): Promise<{ task: TaskRecord; reason: string }>;

  static retryTask(taskId: string, options?: { fromPhase?: HarnessPhase; reason?: string }): Promise<{ task: TaskRecord; transitionedFrom: HarnessPhase }>;

  static rejectStagedDiff(taskId: string, diffId?: number | null, reason?: string): Promise<{ rejectedCount: number; diffs: StagedDiffRecord[] }>;
}

export interface RouteResult {
  modelId: string;
  stage: string;
  confidence: string;
  role: string;
  ruleId?: string | null;
  latencyMs: number;
  costEstimate: string;
  rationale: string;
}

export class KruschCascadeRouter {
  specialists: Record<string, string>;
  escalationPolicy: Record<string, any>;
  constructor(options?: { customModels?: Record<string, string>; escalationPolicy?: Record<string, any> });
  route(prompt: string, context?: Record<string, any>): RouteResult;
}

export class KruschTools {
  taskId: string;
  projectPath: string;
  policy: any;
  constructor(taskId: string, projectPath: string, options?: any);
  getDefinitions(phase?: HarnessPhase | string | null): any[];
  executeTool(name: string, args?: Record<string, any>, options?: { phase?: HarnessPhase | string | null }): Promise<any>;
}

export class KruschStateMachine {
  constructor(options?: any);
  runTask(params: {
    goal: string;
    projectPath?: string;
    maxTurns?: number;
    modelOverride?: string | null;
  }): Promise<{
    status: HarnessPhase;
    reason?: string;
    taskId: string;
    turnsExecuted: number;
    stagedDiffsCount: number;
    finalModel: string;
  }>;
}

export class KruschTrajectoryGuard {
  constructor(options?: { maxTurns?: number; loopWindowSize?: number });
  evaluateTrajectory(turnHistory: any[]): { healthy: boolean; reason?: string; action?: string };
}

export const RSI_MODULES: {
  AGENT_LOOP: string;
  TOOL_USE: string;
  OBSERVATION_MGMT: string;
  CONTEXT_MGMT: string;
  TASK_COMPLETION: string;
};

export const RSI_ACTION_TYPES: {
  REFETCH_SYMBOLS: string;
  SWITCH_TOOL_NORMALIZER: string;
  FORMAT_ASSERTION_DIFF: string;
  ESCALATE_TIER_OR_ABORT: string;
};

export class KruschFailureClassifier {
  static attributeFailure(testRun: any): {
    module: string;
    actionType: string;
    missingSymbol?: string | null;
    diagnosis: string;
    remediation: string;
  };
}

export const KruschModularRSI: typeof KruschFailureClassifier;

export class KruschTestRunner {
  static detectTestCommand(projectPath?: string): string | null;
  static parseErrors(stdout?: string, stderr?: string): any[];
  static runCommand(command: string, cwd?: string, options?: any): Promise<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
    durationMs: number;
    extractedErrors?: any[];
  }>;
}

export class KruschApprovalPolicy {
  autoApprove: boolean;
  floor: ReturnType<typeof createKruschPolicyFloor>;
  constructor(options?: any);
  evaluate(
    toolName: string,
    args?: any
  ): {
    status: 'FORBIDDEN' | 'AUTO_APPROVED' | 'STAGED' | 'REQUIRE_APPROVAL';
    reason: string;
    floorRuleId?: string | null;
  };
}

export const KRUSCH_HARDLINE_FLOOR_RULES: ReadonlyArray<any>;
export function deobfuscateCommand(command: string): string;
export function validateFloorRules(rules?: ReadonlyArray<any>): { valid: boolean; checked: number };
export function createKruschPolicyFloor(options?: {
  extraRules?: Array<any>;
  protectedPaths?: string[];
}): {
  rules: ReadonlyArray<any>;
  evaluate(
    toolName: string,
    args?: Record<string, any>
  ): {
    forbidden: boolean;
    status: 'ALLOWED' | 'FORBIDDEN';
    floorRuleId: string | null;
    reason: string;
  };
};
export function evaluateTruncationGuard(turnResult?: Record<string, any>): {
  poisoned: boolean;
  safeToExecuteTools: boolean;
  reason: string | null;
  truncatedCallIds: string[];
  recoveryPrompt: string | null;
};
export function evaluateVerifyOnStop(state?: {
  phase?: string;
  toolCallsCount?: number;
  pendingDiffsCount?: number;
  latestRunPassed?: boolean;
  verifyRetries?: number;
  maxVerifyRetries?: number;
  verificationCommand?: string | null;
}): {
  allowStop: boolean;
  action: 'ALLOW_STOP' | 'FORCE_VERIFY' | 'ABORT_UNVERIFIED';
  reason: string;
  correctivePrompt: string | null;
};

export class KruschSymbolIndexer {
  static indexProject(projectPath: string, options?: { maxFiles?: number }): Promise<{ filesScanned: number; symbolsIndexed: number }>;
  static extractSymbolsFromFile(filePath: string, relativePath: string, projectPath: string): any[];
  static snapshotTaskSymbols(taskId: string, projectPath: string, filePaths?: string[]): Promise<number>;
}

export class KruschContextClient {
  static assembleContext(projectPath: string, queryText?: string, options?: any): Promise<any>;
  static formatRepoTree(files: string[], maxLines?: number): string;
  static formatSymbols(symbols: any[]): string;
  static formatContextPrompt(context: any): string;
  static searchCodeSymbols(queryTerm: string, limit?: number): Promise<any[]>;
  static getRecentMemories(limit?: number): Promise<any[]>;
  static getProjectFiles(projectPath: string, maxFiles?: number): Promise<string[]>;
  static recordMemory(params: { projectPath?: string; category?: string; content: string; tags?: string[]; taskId?: string | null }): Promise<any>;
}

export interface ApplyJournalRecord {
  id: number;
  task_id: string;
  project_path: string;
  state: 'APPLYING' | 'APPLIED' | 'ROLLED_BACK' | 'FAILED';
  files: Array<{
    diffId: number;
    filePath: string;
    stagedHash: string;
    originalHash: string | null;
    fullPath: string;
  }>;
  error_message?: string | null;
  created_at: string;
  completed_at?: string | null;
}

export class KruschVerificationContract {
  static loadContract(projectPath?: string): any | null;
  static checkPathContracts(contract: any, stagedDiffs?: any[]): { valid: boolean; error?: string };
  static runInStagedTree(projectPath: string, stagedDiffs: any[], options?: any): Promise<{
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    passed: boolean;
    durationMs: number;
    extractedErrors?: any[];
    stagedTreeExecuted?: boolean;
  }>;
  static copyTree(src: string, dest: string, options?: any): void;
}

export function classifyPrompt(prompt: string): {
  isFastPath: boolean;
  role?: string;
  ruleId?: string;
  confidence?: string;
};

export class DefaultKruschRouter {
  specialists: Record<string, string>;
  escalationPolicy: Record<string, any>;
  constructor(options?: any);
  route(prompt: string, context?: any): {
    modelId: string;
    stage: string;
    confidence: string;
    role: string;
    ruleId: string | null;
    latencyMs: number;
    costEstimate: string;
    rationale: string;
  };
}

export function startMcpServer(): Promise<void>;

export interface SandboxExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
  sandboxType: 'bwrap' | 'node_permission' | 'process_jail' | 'process-jail';
  replayToken: string;
}

export const HARNESS_CHOKE_POINT_FILES: readonly string[];

export function planHarnessDisjointWaves(params?: {
  tasks?: Array<{ id?: string; workOrderId?: string; title?: string; targetFiles?: string[]; files?: string[] }>;
  edges?: Array<{ from?: string; to?: string; source_path?: string; target_path?: string }>;
  chokePoints?: Iterable<string>;
}): {
  waves: Array<{ wave: number; taskIds: string[]; parallelizable: boolean; leasedFileCount: number }>;
  leases: Array<{
    taskId: string;
    title: string;
    targetFiles: string[];
    hop1Dependents: string[];
    hop2Dependents: string[];
    leaseCone: string[];
    reservedChokePoints: string[];
    wave: number;
  }>;
  collisions: Array<{ tasks: [string, string]; sharedFiles: string[] }>;
  reservedOrchestratorFiles: string[];
};

export class KruschSandbox {
  static isBwrapAvailable(): boolean;
  static validateCapability(command: string): { allowed: boolean; reason?: string };
  static computeReplayToken(params: { command: string; env?: Record<string, string>; stagedTreePath: string; stagedDiffs?: any[] }): string;
  static runInSandbox(params: {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxBufferBytes?: number;
    stagedDiffs?: any[];
  }): Promise<SandboxExecutionResult>;
}

export class KruschTelemetry {
  static buildTrace(taskId: string): Promise<{
    traceId: string;
    task: any;
    spans: Array<{
      name: string;
      phase?: string;
      durationMs: number;
      attributes: Record<string, any>;
    }>;
    costLedger: {
      totalTokens: number;
      estimatedCostUsd: number;
      l1CpuFastPaths: number;
      modelBreakdown: Record<string, any>;
    };
  }>;
}

export function generateUnifiedDiff(filePath: string, originalContent: string | null, newContent: string): string;

export function enableEphemeralMode(): void;
export function disableEphemeralMode(): void;
export function isEphemeralMode(): boolean;
export function closePool(): Promise<void>;
export const pool: any;
export function query(text: string, params?: any[], options?: { silent?: boolean }): Promise<any>;
export function withTransaction<T = any>(callback: (client: any) => Promise<T>): Promise<T>;

export function redactSecrets(text: string): string;
export function routePipeline(prompt: string): Promise<{
  stage: string;
  tier: string;
  role: string;
  confidence: number;
  recommendedProvider: string;
  recommendedModel: string;
  reason: string;
  durationMs: number;
}>;
export function runDoctor(options?: { sibling?: string }): Promise<boolean>;
export function startBridgeServer(options?: { port?: number; host?: string }): any;
export function runHeadlessCi(
  projectPath?: string,
  options?: { patch?: string; goal?: string }
): Promise<{ taskId: string; journalId: number; appliedCount: number }>;
export function runVerifyModels(): Promise<{ sha256: string; length: number }>;
export function runInvariantDemo(): Promise<{ ok: boolean }>;
export function runBenchmark(options?: { iterations?: number }): Promise<{
  iterations: number;
  applySuccessRate: number;
  applyMedianMs: number;
  applyP95Ms: number;
  driftRefusalRate: number;
  driftMedianMs: number;
  driftP95Ms: number;
}>;
