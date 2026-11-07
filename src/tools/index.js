import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { KruschStateManager, canonicalizePaths } from '../brain/state-manager.js';
import { KruschContextClient } from '../brain/context-client.js';
import { KruschTestRunner } from '../verify/test-runner.js';
import { KruschVerificationContract } from '../verify/contract.js';
import { KruschApprovalPolicy } from '../approvals/policy.js';

export class KruschTools {
  constructor(taskId, projectPath, options = {}) {
    this.taskId = taskId;
    this.projectPath = projectPath;
    this.policy = options.policy || new KruschApprovalPolicy(options);
    this.verificationCommand = options.verificationCommand || null;
  }

  getDefinitions(phase = null) {
    const allDefs = [
      {
        name: 'read_file',
        description: 'Read the token-bounded text content of a file from the repository with line citations.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' },
            startLine: { type: 'integer', description: 'Starting line number (1-indexed, default 1)' },
            endLine: { type: 'integer', description: 'Ending line number (inclusive)' },
            maxLines: { type: 'integer', description: 'Maximum lines to return (default 200, max 500)' }
          },
          required: ['path']
        }
      },
      {
        name: 'list_dir',
        description: 'List files and subdirectories inside a repository directory path.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative directory path (default ".")' }
          },
          required: []
        }
      },
      {
        name: 'edit_file',
        description: 'Stage a targeted string replacement in an existing file into PostgreSQL without re-sending the entire file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' },
            oldString: { type: 'string', description: 'Exact existing substring to replace' },
            newString: { type: 'string', description: 'Replacement string' },
            explanation: { type: 'string', description: 'Rationale for the modification' }
          },
          required: ['path', 'oldString', 'newString']
        }
      },
      {
        name: 'stage_diff',
        description: 'Stage an updated file content into PostgreSQL without immediately touching physical disk (prefer edit_file for existing files).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' },
            content: { type: 'string', description: 'Full updated content of the file' },
            explanation: { type: 'string', description: 'Rationale for the modification' }
          },
          required: ['path', 'content']
        }
      },
      {
        name: 'search_symbols',
        description: 'Search for code symbols, functions, classes, and types in PostgreSQL AST index.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Symbol or signature name to search' }
          },
          required: ['query']
        }
      },
      {
        name: 'run_command',
        description: `Execute a test, build, or verification command.${this.verificationCommand ? ` Target project test command: "${this.verificationCommand}".` : ''}`,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command to run (e.g. npm test)' }
          },
          required: ['command']
        }
      },
      {
        name: 'apply_staged_diff',
        description: 'Apply a staged diff from PostgreSQL to physical disk (strictly guarded: verification must pass and task must be in APPROVAL_GATE).',
        parameters: {
          type: 'object',
          properties: {
            diffId: { type: 'integer', description: 'ID of staged diff row in PostgreSQL' }
          },
          required: ['diffId']
        }
      },
      {
        name: 'finish_plan',
        description: 'Signal that repository discovery and planning is complete, transitioning the task to IMPLEMENT phase.',
        parameters: {
          type: 'object',
          properties: {
            planSummary: { type: 'string', description: 'Concise summary of the implementation plan and files to modify' }
          },
          required: []
        }
      },
      {
        name: 'request_verification',
        description: 'Signal that all staged diffs are ready and request immediate transition to VERIFY phase to run tests.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Rationale or summary of staged modifications ready for verification' }
          },
          required: []
        }
      }
    ];

    if (!phase) {
      return allDefs;
    }

    switch (phase) {
      case 'PLAN':
        // Discovery & formulation; read-only mapping + explicit plan completion
        return allDefs.filter(t => ['read_file', 'list_dir', 'search_symbols', 'finish_plan'].includes(t.name));
      case 'IMPLEMENT':
        // Active staging into PostgreSQL ACID storage; stage and request verification
        return allDefs.filter(t => ['read_file', 'list_dir', 'search_symbols', 'edit_file', 'stage_diff', 'request_verification'].includes(t.name));
      case 'VERIFY':
        // Verification testing; run test commands against staged changes; no stage_diff or apply
        return allDefs.filter(t => ['read_file', 'list_dir', 'run_command'].includes(t.name));
      case 'APPROVAL_GATE':
        // Post-verification diff inspection and disk commit; no new diffs
        return allDefs.filter(t => ['read_file', 'list_dir', 'apply_staged_diff'].includes(t.name));
      default:
        return allDefs;
    }
  }

  async executeTool(name, args = {}, options = {}) {
    // Phase Invariant 1: stage_diff / edit_file strictly require explicit IMPLEMENT phase
    if (name === 'stage_diff' || name === 'edit_file') {
      if (!options.phase || options.phase !== 'IMPLEMENT') {
        return {
          status: 'BLOCKED',
          error: 'INVARIANT_VIOLATION',
          message: `Cannot stage diff: options.phase must be explicitly 'IMPLEMENT' (received '${options.phase || 'none'}'). Code staging is only permitted in IMPLEMENT phase.`
        };
      }
    }

    // Phase Invariant 2: apply_staged_diff strictly requires explicit APPROVAL_GATE phase
    if (name === 'apply_staged_diff') {
      if (!options.phase || options.phase !== 'APPROVAL_GATE') {
        return {
          status: 'BLOCKED',
          error: 'INVARIANT_VIOLATION',
          message: `Cannot apply staged diff to physical disk: options.phase must be explicitly 'APPROVAL_GATE' (received '${options.phase || 'none'}'). Verification tests must pass first.`
        };
      }
    }

    // Phase Invariant 3: run_command is strictly limited to VERIFY phase
    if (name === 'run_command') {
      if (!options.phase || options.phase !== 'VERIFY') {
        return {
          status: 'BLOCKED',
          error: 'INVARIANT_VIOLATION',
          message: `Command execution is strictly prohibited outside VERIFY phase or without explicit phase (received '${options.phase || 'none'}'). Models may not execute shell commands during PLAN or IMPLEMENT.`
        };
      }
    }

    // Phase Invariant 4: finish_plan is only permitted in PLAN
    if (name === 'finish_plan') {
      if (!options.phase || options.phase !== 'PLAN') {
        return {
          status: 'BLOCKED',
          error: 'INVARIANT_VIOLATION',
          message: `finish_plan is only permitted during PLAN phase (received '${options.phase || 'none'}').`
        };
      }
    }

    // Phase Invariant 5: request_verification is only permitted in IMPLEMENT
    if (name === 'request_verification') {
      if (!options.phase || options.phase !== 'IMPLEMENT') {
        return {
          status: 'BLOCKED',
          error: 'INVARIANT_VIOLATION',
          message: `request_verification is only permitted during IMPLEMENT phase (received '${options.phase || 'none'}').`
        };
      }
    }

    const policyResult = this.policy.evaluate(name, args);

    if (policyResult.status === 'FORBIDDEN') {
      return {
        status: 'BLOCKED',
        error: 'POLICY_FLOOR_FORBIDDEN',
        floorRuleId: policyResult.floorRuleId || null,
        message: `Immutable Policy Floor blocked action: ${policyResult.reason}`
      };
    }

    if (policyResult.status === 'REQUIRE_APPROVAL') {
      // Record approval request in PostgreSQL
      const approval = await KruschStateManager.requestApproval(this.taskId, {
        actionType: name,
        targetResource: JSON.stringify(args),
        status: 'PENDING',
        decisionReason: policyResult.reason
      });
      return {
        status: 'APPROVAL_REQUIRED',
        approvalId: approval.id,
        message: `Action requires user approval: ${policyResult.reason}`
      };
    }

    if (name === 'list_dir') {
      const targetRel = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '.';
      try {
        const { projectPath, filePath } = canonicalizePaths(this.projectPath, targetRel);
        const fullPath = path.resolve(projectPath, filePath);
        if (!fs.existsSync(fullPath)) {
          return { error: `Directory not found: ${targetRel}` };
        }
        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
          return { error: `Path is a file, not a directory: ${targetRel}. Use read_file instead.` };
        }
        const entries = fs.readdirSync(fullPath, { withFileTypes: true })
          .filter(d => !d.name.startsWith('.git'))
          .slice(0, 200)
          .map(d => (d.isDirectory() ? `${d.name}/` : d.name));
        return { path: filePath, entries, count: entries.length };
      } catch (err) {
        return { error: `Failed to list directory ${targetRel}: ${err.message}` };
      }
    }

    if (name === 'read_file') {
      if (!args.path || typeof args.path !== 'string') {
        return { error: 'Invalid path: file path must be a non-empty string.' };
      }
      let projectPath;
      let filePath;
      try {
        ({ projectPath, filePath } = canonicalizePaths(this.projectPath, args.path));
      } catch (err) {
        return { error: err.message };
      }
      const fullPath = path.resolve(projectPath, filePath);

      let stagedOverride = null;
      try {
        const pendingDiffs = await KruschStateManager.getPendingDiffs(this.taskId);
        const matched = pendingDiffs.find(d => d.file_path === filePath);
        if (matched && typeof matched.staged_content === 'string') {
          stagedOverride = matched.staged_content;
        }
      } catch (_ignore) {
        // Fallback to disk read if DB query unavailable in standalone unit tests
      }

      if (stagedOverride === null) {
        if (!fs.existsSync(fullPath)) {
          return { error: `File not found: ${args.path}` };
        }
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(fullPath, { withFileTypes: true })
            .filter(d => !d.name.startsWith('.git'))
            .slice(0, 100)
            .map(d => (d.isDirectory() ? `${d.name}/` : d.name));
          return {
            error: `Path '${args.path}' is a directory, not a file. Use list_dir or read one of its files.`,
            directoryEntries: entries
          };
        }
      }

      const rawContent = stagedOverride !== null ? stagedOverride : fs.readFileSync(fullPath, 'utf-8');
      const lines = rawContent.split('\n');
      const totalLines = lines.length;

      const startLine = Math.max(1, parseInt(args.startLine || args.start_line || 1, 10));
      const maxLines = Math.min(parseInt(args.maxLines || args.max_lines || 200, 10), 500);
      const endLine = args.endLine || args.end_line
        ? Math.min(parseInt(args.endLine || args.end_line, 10), totalLines)
        : Math.min(startLine + maxLines - 1, totalLines);

      const slice = lines.slice(startLine - 1, endLine);
      const numberedContent = slice.map((line, idx) => `${startLine + idx} | ${line}`).join('\n');

      return {
        path: filePath,
        startLine,
        endLine,
        totalLines,
        isTruncated: endLine < totalLines,
        citation: `${filePath}:${startLine}-${endLine}`,
        content: numberedContent
      };
    }

    if (name === 'edit_file') {
      if (!args.path || typeof args.path !== 'string') {
        return { error: 'Invalid path: file path must be a non-empty string.' };
      }
      const oldString = args.oldString ?? args.old_string;
      const newString = args.newString ?? args.new_string;
      if (typeof oldString !== 'string' || oldString.length === 0) {
        return { error: 'Invalid oldString: must be a non-empty string to replace.' };
      }
      if (typeof newString !== 'string') {
        return { error: 'Invalid newString: must be a string.' };
      }

      const { projectPath, filePath } = canonicalizePaths(this.projectPath, args.path);
      const fullPath = path.resolve(projectPath, filePath);
      const diskExists = fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory();
      const originalContent = diskExists ? fs.readFileSync(fullPath, 'utf-8') : '';

      let baseContent = originalContent;
      try {
        const pendingDiffs = await KruschStateManager.getPendingDiffs(this.taskId);
        const matched = pendingDiffs.find(d => d.file_path === filePath);
        if (matched && typeof matched.staged_content === 'string') {
          baseContent = matched.staged_content;
        }
      } catch (_ignore) {
        // Fallback to disk content
      }

      if (!baseContent && !diskExists) {
        return { error: `File not found: ${args.path}` };
      }
      if (!baseContent.includes(oldString)) {
        return {
          error: `oldString not found in ${filePath}. Read the target lines with read_file first and pass the exact text (without line number prefixes).`
        };
      }

      const updatedContent = baseContent.replace(oldString, () => newString);
      const stagedRow = await KruschStateManager.stageDiff(this.taskId, {
        filePath: args.path,
        projectPath: this.projectPath,
        originalContent,
        stagedContent: updatedContent,
        diffPatch: args.explanation || `Edited ${filePath}`
      });
      return {
        status: 'STAGED',
        diffId: stagedRow.id,
        filePath: stagedRow.file_path,
        hash: stagedRow.sha256_hash,
        leaseExpiresAt: stagedRow.lease_expires_at,
        message: `Targeted edit staged in PostgreSQL (ID: ${stagedRow.id}). Call request_verification when ready to test.`
      };
    }

    if (name === 'stage_diff') {
      if (!args.path || typeof args.path !== 'string') {
        return { error: 'Invalid path: file path must be a non-empty string.' };
      }
      if (args.content === undefined || args.content === null || typeof args.content !== 'string') {
        return { error: 'Invalid content: staged content must be a valid string.' };
      }
      if (args.content.includes('\0')) {
        return { error: 'Invalid content: binary null bytes detected in staged text content.' };
      }

      const { projectPath, filePath } = canonicalizePaths(this.projectPath, args.path);
      const fullPath = path.resolve(projectPath, filePath);
      const originalContent = (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory())
        ? fs.readFileSync(fullPath, 'utf-8')
        : '';
      const stagedRow = await KruschStateManager.stageDiff(this.taskId, {
        filePath: args.path,
        projectPath: this.projectPath,
        originalContent,
        stagedContent: args.content,
        diffPatch: args.explanation || 'Staged modification'
      });
      return {
        status: 'STAGED',
        diffId: stagedRow.id,
        filePath: stagedRow.file_path,
        hash: stagedRow.sha256_hash,
        leaseExpiresAt: stagedRow.lease_expires_at,
        message: `Changes staged in PostgreSQL (ID: ${stagedRow.id}). Ready for verification.`
      };
    }

    if (name === 'search_symbols') {
      if (!args.query || typeof args.query !== 'string') {
        return { error: 'Invalid query: search query must be a non-empty string.' };
      }
      const symbols = await KruschContextClient.searchCodeSymbols(args.query, 10);
      return { query: args.query, results: symbols };
    }

    if (name === 'run_command') {
      if (!args.command || typeof args.command !== 'string') {
        return { error: 'Invalid command: command must be a non-empty string.' };
      }
      const pendingDiffs = await KruschStateManager.getPendingDiffs(this.taskId);
      const result = await KruschVerificationContract.runInStagedTree(
        this.projectPath,
        pendingDiffs,
        {
          command: args.command,
          verificationCommand: this.verificationCommand
        }
      );
      await KruschStateManager.recordVerificationRun(this.taskId, {
        command: args.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        passed: result.passed,
        extractedErrors: result.extractedErrors || [],
        sandboxType: result.sandboxType || 'process',
        sandboxConfig: result.sandboxConfig || {},
        envSnapshot: result.envSnapshot || {},
        fileManifest: result.fileManifest || [],
        replayToken: result.replayToken || null
      });
      return result;
    }

    if (name === 'apply_staged_diff') {
      if (!args.diffId || typeof args.diffId !== 'number') {
        return { error: 'Invalid diffId: diffId must be an integer.' };
      }
      try {
        const batchResult = await KruschStateManager.applyDiffBatch(this.taskId, [args.diffId], this.projectPath);
        if (batchResult.status === 'APPLIED') {
          return { status: 'APPLIED', diffId: args.diffId, filePath: batchResult.diffs[0]?.filePath };
        }
        return batchResult;
      } catch (err) {
        return { error: err.code || 'CRASH_SAFE_APPLY_FAILED', message: err.message };
      }
    }

    if (name === 'finish_plan') {
      return {
        status: 'PLAN_FINISHED',
        planSummary: args.planSummary || 'Repository inspection complete. Ready to proceed to implementation.',
        message: 'Planning complete. Transitioning to IMPLEMENT phase.'
      };
    }

    if (name === 'request_verification') {
      return {
        status: 'VERIFICATION_REQUESTED',
        reason: args.reason || 'All file modifications staged. Ready for verification.',
        message: 'Verification requested. Transitioning to VERIFY phase.'
      };
    }

    return { error: `Unknown tool: ${name}` };
  }
}
