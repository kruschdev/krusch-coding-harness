import { KruschStateManager } from '../brain/state-manager.js';
import { KruschContextClient } from '../brain/context-client.js';
import { KruschCascadeRouter } from '../router/cascade.js';
import { ModelRegistry } from '../models/registry.js';
import { KruschTools } from '../tools/index.js';
import { KruschTrajectoryGuard } from './trajectory-guard.js';
import { KruschFailureClassifier, RSI_ACTION_TYPES } from './modular-rsi.js';
import { KruschApprovalPolicy } from '../approvals/policy.js';
import { evaluateTruncationGuard, evaluateVerifyOnStop } from '../approvals/policy-floor.js';
import { KruschFSM, HARNESS_PHASES } from './fsm.js';

function getPhaseObjective(phase, verificationCommand) {
  switch (phase) {
    case HARNESS_PHASES.PLAN:
      return `[ACTIVE HARNESS PHASE: PLAN]
Phase Objective: Read-only repository discovery and mapping.
- Inspect relevant files with 'read_file', explore directories with 'list_dir', and locate symbols with 'search_symbols'.
- Propose a concrete implementation plan, then call 'finish_plan' when ready to proceed.
- Invariant Rule: Tools 'edit_file' and 'stage_diff' are strictly withheld in PLAN. Do not attempt disk mutations.`;
    case HARNESS_PHASES.IMPLEMENT:
      return `[ACTIVE HARNESS PHASE: IMPLEMENT]
Phase Objective: Code modification and staging.
- Stage targeted file edits into PostgreSQL ACID substrate using 'edit_file' (preferred for existing files) or 'stage_diff' (for new/small files).
- Call 'request_verification' when all necessary files are staged to proceed to testing.
- Invariant Rule: All staged diffs are stored in PostgreSQL; disk writes remain strictly blocked until verification passes.`;
    case HARNESS_PHASES.VERIFY:
      return `[ACTIVE HARNESS PHASE: VERIFY]
Phase Objective: Ground-truth verification.
- Execute the verification command using 'run_command'${verificationCommand ? ` (Target: "${verificationCommand}")` : ''}.
- Invariant Rule: No new diffs can be staged in VERIFY. Validated pass (exit code 0) is required to unlock APPROVAL_GATE.`;
    case HARNESS_PHASES.APPROVAL_GATE:
      return `[ACTIVE HARNESS PHASE: APPROVAL_GATE]
Phase Objective: Human-in-the-loop inspection and disk commit.
- Verification tests have passed. Apply staged diffs to the working tree using 'apply_staged_diff'.
- Invariant Rule: No new modifications may be staged.`;
    default:
      return `[ACTIVE HARNESS PHASE: ${phase}]`;
  }
}

/**
 * Compact older tool outputs and bulky stage_diff payloads in conversation history
 * so multi-turn debugging stays within 16K local model context windows.
 */
export function compactTurnMessages(messages, keepRecentMessages = 6, maxOldChars = 1200) {
  const cutoff = Math.max(1, messages.length - keepRecentMessages);
  return messages.map((msg, idx) => {
    if (idx === 0 || idx >= cutoff) {
      return msg;
    }
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > maxOldChars) {
      return {
        ...msg,
        content: `${msg.content.slice(0, maxOldChars)}\n...[compacted ${msg.content.length - maxOldChars} chars from earlier turn]`
      };
    }
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      const compactedCalls = msg.tool_calls.map(tc => {
        if (tc.function?.name === 'stage_diff' && typeof tc.function?.arguments === 'string' && tc.function.arguments.length > maxOldChars) {
          try {
            const parsed = JSON.parse(tc.function.arguments);
            if (typeof parsed.content === 'string' && parsed.content.length > 600) {
              parsed.content = `${parsed.content.slice(0, 400)}\n...[compacted ${parsed.content.length - 400} chars of staged file content]`;
              return {
                ...tc,
                function: { ...tc.function, arguments: JSON.stringify(parsed) }
              };
            }
          } catch (_err) {
            // Preserve original arguments if JSON parsing fails
          }
        }
        return tc;
      });
      return { ...msg, tool_calls: compactedCalls };
    }
    return msg;
  });
}

export class KruschStateMachine {
  constructor(options = {}) {
    this.options = options;
    this.router = new KruschCascadeRouter(options);
    this.registry = new ModelRegistry(options);
    this.guard = new KruschTrajectoryGuard(options);
    this.policy = new KruschApprovalPolicy(options);
  }

  /**
   * Run a goal through the complete invariant coding harness lifecycle.
   */
  async runTask({ taskId = null, goal, projectPath = process.cwd(), maxTurns = 10, modelOverride = null, verificationCommand = null, autoApprove = undefined }) {
    // 0. Startup Crash Recovery & Lease Maintenance: inspect and resolve in-flight applies, and prune expired leases
    const recovered = await KruschStateManager.recoverInFlightApplies(projectPath);
    if (recovered.length > 0) {
      console.log(`[krusch] Recovered ${recovered.length} in-flight diff apply operation(s) from prior session.`);
    }
    const pruned = await KruschStateManager.pruneExpiredLeases();
    if (pruned.length > 0) {
      console.log(`[krusch] Pruned ${pruned.length} expired file concurrency lease(s).`);
    }

    const pinnedModel = modelOverride || this.options.pinnedModel || null;
    const shouldAutoApprove = autoApprove !== undefined ? Boolean(autoApprove) : Boolean(this.policy.autoApprove);

    // 1. Initialize Task in PostgreSQL Cognitive Substrate
    let task;
    if (taskId) {
      task = await KruschStateManager.getTask(taskId);
      if (!task) {
        task = await KruschStateManager.createTask({
          id: taskId,
          goal,
          projectPath,
          phase: HARNESS_PHASES.INIT,
          verificationCommand,
          metadata: {
            initiatedBy: 'krusch-harness',
            pinnedModel,
            createdAt: new Date().toISOString()
          }
        });
      }
    } else {
      task = await KruschStateManager.createTask({
        goal,
        projectPath,
        phase: HARNESS_PHASES.INIT,
        verificationCommand,
        metadata: {
          initiatedBy: 'krusch-harness',
          pinnedModel,
          createdAt: new Date().toISOString()
        }
      });
    }

    const fsm = new KruschFSM(task.id, HARNESS_PHASES.INIT);
    console.log(`[krusch] Initialized task ${task.id} in PostgreSQL (Phase: ${fsm.currentPhase})`);

    const policy = new KruschApprovalPolicy({ autoApprove: shouldAutoApprove });
    const tools = new KruschTools(task.id, projectPath, {
      policy,
      verificationCommand: task.verification_command
    });

    // 2. Assemble Grounded Context from AST & Memory
    const context = await KruschContextClient.assembleContext(projectPath, goal);
    const contextPromptBlock = KruschContextClient.formatContextPrompt(context);

    // Transition INIT -> PLAN
    await fsm.transitionTo(HARNESS_PHASES.PLAN);

    // 3. Select Initial Model via Cascade Router
    let route = this.router.route(goal, {
      pinnedModel,
      priorFailureCount: 0
    });

    console.log(`[krusch] Routing: selected [${route.modelId}] via [${route.stage}] (Est: ${route.costEstimate}, Latency: ${route.latencyMs}ms)`);
    await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });

    // Record routing event in PostgreSQL
    await KruschStateManager.recordEvent(task.id, null, 'routing_decision', {
      stage: route.stage,
      modelId: route.modelId,
      latencyMs: route.latencyMs,
      costEstimate: route.costEstimate,
      ruleId: route.ruleId,
      rationale: route.rationale
    });

    // 4. Invariant Prompt Template with Token-Budgeted Context
    const systemPrompt = `You are an engineering coding agent running within the Krusch harness.
Your goal: "${goal}"

${contextPromptBlock}

Operating Workflow Rules:
1. Phase-Scoped Tool Discipline: Each turn operates within an explicit FSM phase with designated tools.
2. In PLAN phase: Inspect and read relevant files before modifying (use token-bounded 'read_file' and 'search_symbols').
3. In IMPLEMENT phase: Use 'stage_diff' to propose modifications into PostgreSQL ACID storage.
4. In VERIFY phase: Use 'run_command' to run existing tests or verify syntax.
5. In APPROVAL_GATE phase: Apply staged diffs to disk via 'apply_staged_diff' once verified.`;

    const messages = [
      { role: 'user', content: `Execute the following engineering goal: ${goal}` }
    ];

    const turnHistory = [];
    let consecutiveTestFailures = 0;
    let latestTestPassed = false;
    let latestFailureClass = null;
    let remediationCount = 0;
    const MAX_REMEDIATIONS = 3;
    let hasReadInPlan = false;
    let verifyFailureRevisits = 0;
    let verifyStopRetries = 0;
    const maxPhaseRevisits = this.options.maxPhaseRevisits || 3;

    for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
      console.log(`[krusch] ─── Turn ${turnNum}/${maxTurns} [Phase: ${fsm.currentPhase} | Model: ${route.modelId}] ───`);

      // Trajectory health check
      const trajectoryStatus = this.guard.evaluateTrajectory(turnHistory);
      if (!trajectoryStatus.healthy) {
        console.warn(`[krusch] Trajectory Guard triggered: ${trajectoryStatus.reason}`);
        if (trajectoryStatus.action === 'ESCALATE_TO_FRONTIER') {
          route = this.router.route(goal, {
            pinnedModel,
            priorFailureCount: 2,
            requireFrontier: true,
            forceEscalate: true
          });
          console.log(`[krusch] Escalating turn to frontier model: ${route.modelId}`);
          await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });
        } else {
          await fsm.transitionTo(HARNESS_PHASES.ABORTED, { reason: trajectoryStatus.reason });
          return { status: HARNESS_PHASES.ABORTED, reason: trajectoryStatus.reason, taskId: task.id };
        }
      }

      // 1. Determine active phase and phase-scoped tool definitions
      const activeToolDefs = tools.getDefinitions(fsm.currentPhase);
      const phaseDirective = getPhaseObjective(fsm.currentPhase, task.verification_command);

      // Refresh system prompt on each turn with current phase objective and context block
      const dynamicSystemPrompt = `You are an engineering coding agent running within the Krusch harness.
Your goal: "${goal}"

${phaseDirective}

${contextPromptBlock}

Operating Workflow Rules:
1. Phase-Scoped Tool Discipline: Each turn operates within an explicit FSM phase with designated tools.
2. In PLAN phase: Inspect and read relevant files before modifying (use token-bounded 'read_file', 'list_dir', and 'search_symbols'). Call 'finish_plan' when ready to proceed.
3. In IMPLEMENT phase: Use 'edit_file' (preferred for existing files) or 'stage_diff' to propose modifications into PostgreSQL ACID storage. Call 'request_verification' when staging is complete.
4. In VERIFY phase: Use 'run_command' to run existing tests or verify syntax.
5. In APPROVAL_GATE phase: Apply staged diffs to disk via 'apply_staged_diff' once verified.`;

      // System message is always at index 0 and updated with active phase directive; compact older turns
      const compactedHistory = compactTurnMessages(messages);
      const turnMessages = [
        { role: 'system', content: dynamicSystemPrompt },
        ...compactedHistory
      ];

      // Execute Model Turn with phase-scoped tools
      const adapter = this.registry.getAdapter(route.modelId);
      const turnResult = await adapter.execute({
        modelId: route.modelId,
        messages: turnMessages,
        tools: activeToolDefs
      });

      // Record Turn in PostgreSQL
      const recordedTurn = await KruschStateManager.recordTurn(task.id, {
        turnNumber: turnNum,
        modelId: route.modelId,
        inputMessages: turnMessages,
        outputText: turnResult.text,
        tokenUsage: turnResult.usage,
        latencyMs: turnResult.latencyMs,
        routingStage: route.stage
      });

      turnHistory.push({
        turnNumber: turnNum,
        outputText: turnResult.text,
        toolCalls: turnResult.toolCalls
      });

      // Truncation-Poisoning Guard (INV-HE-03): never execute half-truncated or malformed tool calls
      const truncationCheck = evaluateTruncationGuard(turnResult);
      if (truncationCheck.poisoned) {
        console.warn(`[krusch:guard] Truncation-Poisoning Guard blocked tool execution: ${truncationCheck.reason}`);
        await KruschStateManager.recordEvent(task.id, recordedTurn.id, 'truncation_poisoning_blocked', truncationCheck);
        messages.push({
          role: 'assistant',
          content: turnResult.text || '[truncated tool output omitted]'
        });
        messages.push({
          role: 'user',
          content: truncationCheck.recoveryPrompt
        });
        continue;
      }

      // Add assistant response to context
      const assistantMessage = {
        role: 'assistant',
        content: turnResult.text || ''
      };
      if (turnResult.toolCalls.length > 0) {
        assistantMessage.tool_calls = turnResult.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) }
        }));
      }
      messages.push(assistantMessage);

      let planFinishedSignal = false;
      let verificationRequested = false;
      let stagedInThisTurn = false;

      // Execute Tool Invocations
      for (const toolCall of turnResult.toolCalls) {
        if (toolCall.name === 'read_file' || toolCall.name === 'list_dir' || toolCall.name === 'search_symbols') {
          if (fsm.currentPhase === HARNESS_PHASES.PLAN) {
            hasReadInPlan = true;
          }
        }
        if (toolCall.name === 'finish_plan') {
          planFinishedSignal = true;
        }
        if (toolCall.name === 'stage_diff' || toolCall.name === 'edit_file') {
          stagedInThisTurn = true;
        }
        if (toolCall.name === 'request_verification') {
          verificationRequested = true;
        }

        console.log(`[krusch] Executing tool [${toolCall.name}]:`, JSON.stringify(toolCall.args));
        const result = await tools.executeTool(toolCall.name, toolCall.args, { phase: fsm.currentPhase });

        // Record event in PostgreSQL
        await KruschStateManager.recordEvent(task.id, recordedTurn.id, `tool_${toolCall.name}`, {
          args: toolCall.args,
          result
        });

        // Test failure analysis via KruschFailureClassifier
        if (toolCall.name === 'run_command') {
          latestTestPassed = result.passed;
          if (!result.passed) {
            consecutiveTestFailures++;
            const failureAttribution = KruschFailureClassifier.attributeFailure(result);
            latestFailureClass = failureAttribution.module;
            console.warn(`[krusch:classifier] Verification Failure attributed to [${failureAttribution.module}]: ${failureAttribution.diagnosis}`);

            let remediationPayload = null;
            if (remediationCount < MAX_REMEDIATIONS) {
              remediationCount++;
              remediationPayload = {
                module: failureAttribution.module,
                actionType: failureAttribution.actionType,
                diagnosis: failureAttribution.diagnosis,
                remediation: failureAttribution.remediation
              };

              if (failureAttribution.actionType === RSI_ACTION_TYPES.REFETCH_SYMBOLS && failureAttribution.missingSymbol) {
                const matchedSymbols = await KruschContextClient.searchCodeSymbols(failureAttribution.missingSymbol, 5);
                remediationPayload.matchedSymbols = matchedSymbols;
              }
            }

            // Escalate model if multiple consecutive verification failures occur
            if (consecutiveTestFailures >= 2 && route.stage !== 'FRONTIER_ESCALATION') {
              route = this.router.route(goal, {
                pinnedModel,
                priorFailureCount: consecutiveTestFailures,
                failureClass: latestFailureClass,
                requireFrontier: true,
                forceEscalate: true
              });
              console.log(`[krusch] Escalating to [${route.modelId}] due to repeated verification failures.`);
              await KruschStateManager.updateTask(task.id, { currentModel: route.modelId });
            }

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                output: result.stdout || result.stderr,
                exit_code: result.exitCode,
                passed: false,
                diagnostic: failureAttribution.diagnosis,
                remediation: remediationPayload
              })
            });
            continue;
          } else {
            consecutiveTestFailures = 0;
            latestFailureClass = null;
            console.log(`[krusch:verify] Verification passed with exit code 0.`);
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }

      // ─── Post-Turn State-Evidence Evaluation ───
      const pendingDiffs = await KruschStateManager.getPendingDiffs(task.id);
      const latestRun = await KruschStateManager.getLatestVerificationRun(task.id);
      let pushedUserReply = false;

      if (fsm.currentPhase === HARNESS_PHASES.PLAN) {
        if (planFinishedSignal) {
          await fsm.transitionTo(HARNESS_PHASES.IMPLEMENT);
          console.log(`[krusch:fsm] Planning completed via finish_plan. Transitioned PLAN -> IMPLEMENT.`);
        } else if (turnResult.toolCalls.length === 0) {
          if (hasReadInPlan) {
            await fsm.transitionTo(HARNESS_PHASES.IMPLEMENT);
            console.log(`[krusch:fsm] Planning concluded with implementation formulation. Transitioned PLAN -> IMPLEMENT.`);
          } else if (pendingDiffs.length === 0 && fsm.canTransitionTo(HARNESS_PHASES.COMMITTED)) {
            await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
            console.log(`[krusch:fsm] Read-only task completed in PLAN phase. Transitioned to COMMITTED.`);
            break;
          }
        } else {
          console.log(`[krusch:fsm] Exploration continues in PLAN phase.`);
        }
      } else if (fsm.currentPhase === HARNESS_PHASES.IMPLEMENT) {
        if (verificationRequested) {
          if (pendingDiffs.length > 0) {
            await fsm.transitionTo(HARNESS_PHASES.VERIFY);
            console.log(`[krusch:fsm] Verification explicitly requested with ${pendingDiffs.length} staged diff(s). Transitioned IMPLEMENT -> VERIFY.`);
          } else {
            console.warn(`[krusch:fsm] Verification requested but no pending diffs staged. Remaining in IMPLEMENT.`);
          }
        } else if (!stagedInThisTurn && pendingDiffs.length > 0) {
          await fsm.transitionTo(HARNESS_PHASES.VERIFY);
          console.log(`[krusch:fsm] Staging completed (${pendingDiffs.length} pending diffs). Transitioned IMPLEMENT -> VERIFY.`);
        } else if (stagedInThisTurn) {
          console.log(`[krusch:fsm] Active diff staged this turn. Remaining in IMPLEMENT for multi-file staging.`);
        }
      } else if (fsm.currentPhase === HARNESS_PHASES.VERIFY) {
        if (latestRun && latestRun.passed && latestRun.exit_code === 0) {
          await fsm.transitionTo(HARNESS_PHASES.APPROVAL_GATE);
          console.log(`[krusch:fsm] Ground-truth verification PASSED. Transitioned VERIFY -> APPROVAL_GATE.`);

          if (shouldAutoApprove) {
            const batchResult = await KruschStateManager.applyDiffBatch(task.id, null, projectPath);
            await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
            console.log(`[krusch:fsm] Auto-applied ${batchResult.appliedCount} staged diff(s) to physical disk. Task COMMITTED.`);
          }
          break;
        } else if (latestRun && !latestRun.passed && turnResult.toolCalls.some(tc => tc.name === 'run_command')) {
          verifyFailureRevisits++;
          if (verifyFailureRevisits >= maxPhaseRevisits) {
            const abortReason = `Exceeded maximum verification retry budget (${maxPhaseRevisits} revisits). Aborting task to prevent oscillation.`;
            console.error(`[krusch:fsm] ${abortReason}`);
            await fsm.transitionTo(HARNESS_PHASES.ABORTED, { reason: abortReason });
            return {
              status: HARNESS_PHASES.ABORTED,
              reason: abortReason,
              taskId: task.id,
              turnsExecuted: turnHistory.length,
              stagedDiffsCount: pendingDiffs.length,
              finalModel: route.modelId
            };
          }
          await fsm.transitionTo(HARNESS_PHASES.IMPLEMENT);
          console.warn(`[krusch:fsm] Verification failed (attempt ${verifyFailureRevisits}/${maxPhaseRevisits}). Transitioned VERIFY -> IMPLEMENT to allow restaging.`);
        } else if (turnResult.toolCalls.length === 0) {
          // Verify-on-Stop Outer Loop Guard (INV-HE-04): veto premature prose stop when staged diffs remain unverified
          const stopCheck = evaluateVerifyOnStop({
            phase: fsm.currentPhase,
            toolCallsCount: 0,
            pendingDiffsCount: pendingDiffs.length,
            latestRunPassed: false,
            verifyRetries: verifyStopRetries,
            maxVerifyRetries: maxPhaseRevisits,
            verificationCommand: task.verification_command
          });
          if (!stopCheck.allowStop) {
            verifyStopRetries++;
            console.warn(`[krusch:guard] Verify-on-Stop Guard vetoed exit: ${stopCheck.reason}`);
            await KruschStateManager.recordEvent(task.id, recordedTurn.id, 'verify_on_stop_veto', stopCheck);
            if (stopCheck.action === 'ABORT_UNVERIFIED') {
              await fsm.transitionTo(HARNESS_PHASES.ABORTED, { reason: stopCheck.reason });
              return {
                status: HARNESS_PHASES.ABORTED,
                reason: stopCheck.reason,
                taskId: task.id,
                turnsExecuted: turnHistory.length,
                stagedDiffsCount: pendingDiffs.length,
                finalModel: route.modelId
              };
            }
            messages.push({
              role: 'user',
              content: stopCheck.correctivePrompt
            });
            pushedUserReply = true;
          }
        }
      }

      // Preserve strict user/assistant role alternation when a turn had no tool calls
      if (turnResult.toolCalls.length === 0 && !pushedUserReply) {
        messages.push({
          role: 'user',
          content: `Proceed with phase ${fsm.currentPhase} by invoking the appropriate tool (${activeToolDefs.map(t => t.name).join(', ')}).`
        });
      }
    }

    // Check for pending staged diffs and return authoritative status
    const allDiffs = await KruschStateManager.getStagedDiffs(task.id);
    return {
      status: fsm.currentPhase,
      taskId: task.id,
      turnsExecuted: turnHistory.length,
      stagedDiffsCount: allDiffs.length,
      finalModel: route.modelId
    };
  }
}

