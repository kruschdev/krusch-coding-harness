import { createKruschPolicyFloor } from './policy-floor.js';

export class KruschApprovalPolicy {
  constructor(options = {}) {
    this.autoApprove = options.autoApprove ?? (process.env.KRUSCH_AUTO_APPROVE === 'true');
    this.floor = options.floor || createKruschPolicyFloor(options);
  }

  /**
   * Evaluate if a tool action is hard-blocked by the policy floor, can execute immediately,
   * be staged in DB, or require user approval.
   * @returns {{ status: 'FORBIDDEN' | 'AUTO_APPROVED' | 'STAGED' | 'REQUIRE_APPROVAL', reason: string, floorRuleId?: string }}
   */
  evaluate(toolName, args = {}) {
    // 0. Immutable Policy Floor (INV-HE-02): survives autoApprove / yolo modes
    const floorDecision = this.floor.evaluate(toolName, args);
    if (floorDecision.forbidden) {
      return {
        status: 'FORBIDDEN',
        floorRuleId: floorDecision.floorRuleId,
        reason: floorDecision.reason
      };
    }

    // 1. Read-only and phase-transition signaling tools are always auto-approved
    const readOnlyTools = ['read_file', 'search_symbols', 'list_files', 'list_dir', 'get_context', 'view_diff', 'finish_plan', 'request_verification'];
    if (readOnlyTools.includes(toolName)) {
      return { status: 'AUTO_APPROVED', reason: 'Read-only or phase-transition tool operation.' };
    }

    // 2. File mutations staged in PostgreSQL do not touch physical disk yet
    if (toolName === 'stage_diff' || toolName === 'edit_file') {
      return { status: 'STAGED', reason: 'Mutation staged into PostgreSQL ACID table.' };
    }

    // 3. Applying staged diffs to disk
    if (toolName === 'apply_staged_diff') {
      if (this.autoApprove) {
        return { status: 'AUTO_APPROVED', reason: 'Auto-approve policy active.' };
      }
      return { status: 'REQUIRE_APPROVAL', reason: `Disk mutation requires approval for ${args.filePath || 'staged files'}.` };
    }

    // 4. Shell commands
    if (toolName === 'run_command') {
      const cmd = (args.command || '').toLowerCase();
      const dangerousPatterns = ['rm -rf', 'drop table', 'truncate', 'git reset --hard', 'kill -9', 'shutdown'];
      for (const pattern of dangerousPatterns) {
        if (cmd.includes(pattern)) {
          return { status: 'REQUIRE_APPROVAL', reason: `Destructive pattern detected in shell command: "${pattern}".` };
        }
      }

      // Safe test/lint commands can be auto-approved
      if (cmd.startsWith('npm test') || cmd.startsWith('vitest') || cmd.startsWith('node --test')) {
        return { status: 'AUTO_APPROVED', reason: 'Safe verification command.' };
      }

      if (this.autoApprove) {
        return { status: 'AUTO_APPROVED', reason: 'Auto-approve policy active.' };
      }

      return { status: 'REQUIRE_APPROVAL', reason: `Shell command execution: "${args.command}".` };
    }

    return { status: 'REQUIRE_APPROVAL', reason: `Unrecognized tool action: ${toolName}.` };
  }
}
