import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

import { KruschStateMachine } from '../workflow/state-machine.js';
import { KruschStateManager } from '../brain/state-manager.js';
import { KruschFSM, HARNESS_PHASES } from '../workflow/fsm.js';
import { query, pool } from '../brain/pool.js';

const HARNESS_VERSION = '0.1.0';
const mcpBrickUrl = new URL('../../../../lib/mcp-server.js', import.meta.url);
const mcpBrickSpec = '@krusch/toolkit/mcp';

let defineMcpTool = null;
let registerMcpHandlers = null;
let connectToolkitMcpServer = null;

if (fs.existsSync(mcpBrickUrl)) {
  try {
    ({
      defineMcpTool,
      registerMcpHandlers,
      createMcpServer: connectToolkitMcpServer,
    } = await import(mcpBrickUrl.href));
  } catch {
    defineMcpTool = null;
  }
}

if (!defineMcpTool || !registerMcpHandlers || !connectToolkitMcpServer) {
  try {
    ({
      defineMcpTool,
      registerMcpHandlers,
      createMcpServer: connectToolkitMcpServer,
    } = await import(mcpBrickSpec));
  } catch {
    const sdkTypesSpec = '@modelcontextprotocol/sdk/types.js';
    const { CallToolRequestSchema, ListToolsRequestSchema } = await import(sdkTypesSpec);
    defineMcpTool = ({
      name,
      title,
      description = '',
      inputSchema = { type: 'object', properties: {} },
      annotations = {},
      readOnlyHint,
      destructiveHint,
      idempotentHint,
      openWorldHint,
      ...rest
    } = {}) => ({
      ...rest,
      name,
      description,
      inputSchema,
      annotations: {
        ...annotations,
        title: String(annotations?.title || title || name),
        readOnlyHint: Boolean(readOnlyHint ?? annotations?.readOnlyHint ?? true),
        destructiveHint: Boolean(destructiveHint ?? annotations?.destructiveHint ?? false),
        idempotentHint: Boolean(idempotentHint ?? annotations?.idempotentHint ?? true),
        openWorldHint: Boolean(openWorldHint ?? annotations?.openWorldHint ?? false),
      },
    });
    registerMcpHandlers = (srv, tools = [], toolHandler, opts = {}) => {
      const normalizedTools = tools.map((tool) => defineMcpTool(tool));
      srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: normalizedTools }));
      srv.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = String(request?.params?.name ?? '');
        const toolArgs = request?.params?.arguments ?? {};
        try {
          return await toolHandler(toolName, toolArgs, request);
        } catch (err) {
          if (
            opts.rethrowMcpError === true &&
            err &&
            typeof err === 'object' &&
            (err instanceof McpError ||
              err.name === 'McpError' ||
              (typeof err.code === 'number' && err.code <= -32000))
          ) {
            throw err;
          }
          return {
            isError: true,
            content: [{ type: 'text', text: `Krusch Error: ${err?.message || String(err)}` }],
          };
        }
      });
      return { server: srv, normalizedTools };
    };
    connectToolkitMcpServer = async (name, version, tools = [], toolHandler, opts = {}) => {
      const srv = opts.server || new Server({ name, version }, { capabilities: { tools: {} } });
      registerMcpHandlers(srv, tools, toolHandler, opts);
      const stdioSpec = '@modelcontextprotocol/sdk/server/' + 'stdio.js';
      const transport = opts.transport || new (await import(stdioSpec)).StdioServerTransport();
      await srv.connect(transport);
      return srv;
    };
  }
}

// Invariant #567: All 7 MCP tools must declare readOnlyHint, destructiveHint, idempotentHint, and openWorldHint
const HARNESS_TOOLS = [
  defineMcpTool({
    name: 'krusch_run',
    description: 'Asynchronously launch an engineering task in the Krusch harness. Returns immediately with taskId for polling.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true
    },
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Engineering task or objective' },
        projectPath: { type: 'string', description: 'Working directory path (defaults to current)' },
        modelOverride: { type: 'string', description: 'Optional model override' },
        autoApprove: { type: 'boolean', description: 'Whether to auto-apply diffs upon passing verification' },
        useMock: { type: 'boolean', description: 'Run with local deterministic mock adapter (offline/testing)' }
      },
      required: ['goal']
    }
  }),
  defineMcpTool({
    name: 'krusch_task_status',
    description: 'Poll real-time task status, phase transitions, latest verification, and recent events from PostgreSQL.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' }
      },
      required: ['taskId']
    }
  }),
  defineMcpTool({
    name: 'krusch_diff',
    description: 'Inspect unified diffs of all staged modifications held in PostgreSQL for review in Krusch Control Plane.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' }
      },
      required: ['taskId']
    }
  }),
  defineMcpTool({
    name: 'krusch_apply_diff',
    description: 'Approve and apply verified staged diffs from PostgreSQL to physical disk via 2PC apply journal.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        diffId: { type: 'integer', description: 'Optional specific diff ID; applies all verified diffs if omitted' }
      },
      required: ['taskId']
    }
  }),
  defineMcpTool({
    name: 'krusch_explain',
    description: 'Explain transition feasibility, invariant blockers, and ground-truth verification diagnostics for a task.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' }
      },
      required: ['taskId']
    }
  }),
  defineMcpTool({
    name: 'krusch_reject',
    description: 'Reject one or all staged diffs for a task, preventing apply and releasing leases.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        diffId: { type: 'integer', description: 'Optional specific diff ID to reject' },
        reason: { type: 'string', description: 'Rationale for rejection' }
      },
      required: ['taskId']
    }
  }),
  defineMcpTool({
    name: 'krusch_abort',
    description: 'Explicitly abort an active or waiting task, releasing all file concurrency leases.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        reason: { type: 'string', description: 'Rationale for aborting' }
      },
      required: ['taskId']
    }
  })
];

function createHarnessToolDispatcher(server) {
  return async function dispatchHarnessTool(name, rawArgs = {}) {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

    try {
      if (name === 'krusch_run') {
        if (!args.goal || typeof args.goal !== 'string' || args.goal.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'goal' must be a non-empty string");
        }
        if (args.goal.length > 50000) {
          throw new McpError(ErrorCode.InvalidParams, "'goal' exceeds maximum allowed length of 50,000 characters");
        }

        let projectPath = process.cwd();
        if (args.projectPath) {
          if (typeof args.projectPath !== 'string' || args.projectPath.trim().length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "'projectPath' must be a non-empty string path");
          }
          const resolved = path.resolve(args.projectPath);
          if (!fs.existsSync(resolved)) {
            throw new McpError(ErrorCode.InvalidParams, `Directory not found for projectPath: ${args.projectPath}`);
          }
          try {
            const stat = fs.statSync(resolved);
            if (!stat.isDirectory()) {
              throw new McpError(ErrorCode.InvalidParams, `Target projectPath is not a directory: ${args.projectPath}`);
            }
          } catch (e) {
            throw new McpError(ErrorCode.InvalidParams, `Cannot access projectPath: ${e.message}`);
          }
          projectPath = resolved;
        }

        const taskId = `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const autoApprove = Boolean(args.autoApprove);
        const useMock = Boolean(args.useMock);
        const modelOverride = (typeof args.modelOverride === 'string' && args.modelOverride.trim()) ? args.modelOverride.trim() : null;

        // Initialize task record synchronously so taskId is immediately valid
        await KruschStateManager.createTask({
          id: taskId,
          goal: args.goal.trim(),
          projectPath,
          phase: 'INIT'
        });

        // Launch execution asynchronously in background (non-blocking for stdio transport)
        const harness = new KruschStateMachine({
          autoApprove,
          useMock,
          simulateMockTrajectory: useMock,
          pinnedModel: modelOverride
        });

        const taskPromise = harness.runTask({
          taskId,
          goal: args.goal.trim(),
          projectPath,
          modelOverride,
          autoApprove
        }).catch(err => {
          console.error(`[krusch:mcp] Background execution error for ${taskId}: ${err.message}`);
        });

        server.registerTask(taskId, taskPromise);

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              taskId,
              status: 'STARTED',
              phase: 'INIT',
              message: 'Task successfully initialized. Poll krusch_task_status to monitor execution.'
            }, null, 2)
          }]
        };
      }

      if (name === 'krusch_task_status') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }

        // Fetch recent events for timeline
        const eventsRes = await query(
          'SELECT event_type, payload, created_at FROM krusch_events WHERE task_id = $1 ORDER BY id DESC LIMIT 10',
          [taskId]
        );

        const statusReport = {
          taskId: task.id,
          goal: task.goal,
          phase: task.phase,
          currentModel: task.current_model,
          turnsCount: task.turns.length,
          stagedDiffsCount: task.stagedDiffs.length,
          pendingDiffsCount: task.stagedDiffs.filter(d => d.status === 'PENDING').length,
          appliedDiffsCount: task.stagedDiffs.filter(d => d.status === 'APPLIED' || d.status === 'COMMITTED').length,
          committedDiffsCount: task.stagedDiffs.filter(d => d.status === 'COMMITTED').length,
          latestVerification: task.verifications[0] || null,
          isCompleted: ['COMMITTED', 'ABORTED'].includes(task.phase),
          isWaitingApproval: task.phase === 'APPROVAL_GATE',
          recentEvents: eventsRes.rows
        };

        return { content: [{ type: 'text', text: JSON.stringify(statusReport, null, 2) }] };
      }

      if (name === 'krusch_diff') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }
        const diffs = task.stagedDiffs.map(d => ({
          id: d.id,
          filePath: d.file_path,
          status: d.status,
          patch: d.diff_patch,
          sha256: d.sha256_hash,
          leaseExpiresAt: d.lease_expires_at
        }));
        return { content: [{ type: 'text', text: JSON.stringify(diffs, null, 2) }] };
      }

      if (name === 'krusch_apply_diff') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        if (args.diffId !== undefined && args.diffId !== null && (!Number.isInteger(args.diffId) || args.diffId <= 0)) {
          throw new McpError(ErrorCode.InvalidParams, "'diffId' must be a positive integer");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }

        const diffIds = args.diffId ? [args.diffId] : null;
        const batchRes = await KruschStateManager.applyDiffBatch(taskId, diffIds, task.project_path || process.cwd());
        const remainingPending = await KruschStateManager.getPendingDiffs(taskId);
        if (remainingPending.length === 0) {
          try {
            const fsm = new KruschFSM(taskId, task.phase);
            await fsm.transitionTo(HARNESS_PHASES.COMMITTED);
          } catch (_) {
            await KruschStateManager.updateTask(taskId, { phase: HARNESS_PHASES.COMMITTED });
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(batchRes, null, 2) }] };
      }

      if (name === 'krusch_explain') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        const taskId = args.taskId.trim();
        const exp = await KruschStateManager.explainTaskStatus(taskId);
        if (!exp) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }
        return { content: [{ type: 'text', text: JSON.stringify(exp, null, 2) }] };
      }

      if (name === 'krusch_reject') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        if (args.diffId !== undefined && args.diffId !== null && (!Number.isInteger(args.diffId) || args.diffId <= 0)) {
          throw new McpError(ErrorCode.InvalidParams, "'diffId' must be a positive integer");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }
        const reason = (typeof args.reason === 'string' && args.reason.trim()) ? args.reason.trim() : 'Rejected via MCP';
        const rejectRes = await KruschStateManager.rejectStagedDiff(taskId, args.diffId || null, reason);
        return { content: [{ type: 'text', text: JSON.stringify(rejectRes, null, 2) }] };
      }

      if (name === 'krusch_abort') {
        if (!args.taskId || typeof args.taskId !== 'string' || args.taskId.trim().length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "'taskId' must be a non-empty string");
        }
        const taskId = args.taskId.trim();
        const task = await KruschStateManager.getTask(taskId);
        if (!task) {
          throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
        }
        const reason = (typeof args.reason === 'string' && args.reason.trim()) ? args.reason.trim() : 'Aborted via MCP';
        const abortRes = await KruschStateManager.abortTask(taskId, reason);
        return { content: [{ type: 'text', text: JSON.stringify(abortRes, null, 2) }] };
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (err) {
      if (
        err instanceof McpError ||
        err?.name === 'McpError' ||
        (typeof err?.code === 'number' && err.code <= -32000)
      ) {
        throw err;
      }
      return {
        isError: true,
        content: [{ type: 'text', text: `Krusch Error: ${err.message}` }]
      };
    }
  };
}

/**
 * Factory function creating and configuring the Krusch MCP Server instance.
 * Allows in-memory testing without spawning stdio child processes.
 */
export function createMcpServer(options = {}) {
  const shutdownTimeoutMs = Number(options.shutdownTimeoutMs ?? 30_000);
  const maxActiveTasks = Math.max(1, Number(options.maxActiveTasks ?? 10_000));
  const server = new Server(
    { name: 'krusch-harness', version: HARNESS_VERSION },
    { capabilities: { tools: {} } }
  );

  const activeTasks = new Map();
  let isClosing = false;
  let closingPromise = null;

  server.registerTask = (id, taskPromise) => {
    const taskKey = String(id || '').trim();
    if (!taskKey) {
      throw new McpError(ErrorCode.InvalidParams, 'Task ID must be a non-empty string');
    }
    if (isClosing) {
      throw new McpError(ErrorCode.InternalError, 'Cannot register task: MCP server is shutting down');
    }
    if (activeTasks.size >= maxActiveTasks) {
      throw new McpError(
        ErrorCode.InternalError,
        `Maximum active task limit reached (${maxActiveTasks})`
      );
    }
    if (activeTasks.has(taskKey)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Duplicate active task ID: ${taskKey}`
      );
    }
    const tracked = Promise.resolve(taskPromise);
    if (isClosing) {
      throw new McpError(ErrorCode.InternalError, 'Cannot register task: MCP server is shutting down');
    }
    activeTasks.set(taskKey, tracked);
    tracked.finally(() => {
      if (activeTasks.get(taskKey) === tracked) {
        activeTasks.delete(taskKey);
      }
    });
    return tracked;
  };

  server.listTasks = () => Array.from(activeTasks.keys());

  const originalClose = server.close.bind(server);
  server.close = async () => {
    if (closingPromise) {
      return closingPromise;
    }
    isClosing = true;
    closingPromise = (async () => {
      if (activeTasks.size > 0) {
        let timer = null;
        const drainSequentially = async () => {
          while (activeTasks.size > 0) {
            const snapshot = Array.from(activeTasks.values());
            await Promise.allSettled(snapshot);
          }
        };
        try {
          await Promise.race([
            drainSequentially(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('MCP shutdown timeout')), shutdownTimeoutMs);
            })
          ]);
        } catch (err) {
          console.warn(
            `MCP shutdown timed out after ${Math.round(shutdownTimeoutMs / 1000)} s – forcing termination of remaining tasks`
          );
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      return originalClose();
    })();
    return closingPromise;
  };

  const dispatchHarnessTool = createHarnessToolDispatcher(server);
  registerMcpHandlers(server, HARNESS_TOOLS, dispatchHarnessTool, {
    validateArgs: false,
    rethrowMcpError: true,
    serverName: 'krusch-harness',
  });

  return server;
}

/**
 * Krusch MCP Server CLI runner
 *
 * Exposes a thin, 7-tool async control plane interface for KD Code / IDEs:
 * 1. krusch_run: Non-blocking asynchronous task dispatch.
 * 2. krusch_task_status: Polling status endpoint with event timeline and verification state.
 * 3. krusch_diff: Unified diff inspector for staged modifications in PostgreSQL.
 * 4. krusch_apply_diff: Human approval trigger to 2PC journal and write working tree.
 * 5. krusch_explain: Invariant blocker diagnostics & transition feasibility.
 * 6. krusch_reject: Reject staged diffs and release file concurrency leases.
 * 7. krusch_abort: Explicitly abort task and unlock working tree leases.
 */
export async function startMcpServer(options = {}) {
  // Startup Crash Recovery & Lease Maintenance for long-lived MCP server
  try {
    const recovered = await KruschStateManager.recoverInFlightApplies();
    if (recovered.length > 0) {
      console.error(`[krusch:mcp] Recovered ${recovered.length} in-flight diff apply operation(s)`);
    }
    const pruned = await KruschStateManager.pruneExpiredLeases();
    if (pruned.length > 0) {
      console.error(`[krusch:mcp] Pruned ${pruned.length} expired file lease(s)`);
    }
  } catch (err) {
    console.error(`[krusch:mcp] Startup recovery warning: ${err.message}`);
  }

  const server = createMcpServer(options);
  await connectToolkitMcpServer(
    'krusch-harness',
    HARNESS_VERSION,
    HARNESS_TOOLS,
    createHarnessToolDispatcher(server),
    {
      server,
      transport: options.transport,
      validateArgs: false,
      rethrowMcpError: true,
    }
  );
  console.error('[krusch:mcp] Krusch MCP Server connected over stdio');

  const shutdown = async () => {
    console.error('[krusch:mcp] Shutting down...');
    try { await server.close(); } catch (_) { }
    try { await pool.end(); } catch (_) { }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('mcp-server.js')) {
  startMcpServer().catch(err => {
    console.error('Failed to start Krusch MCP server:', err);
    process.exit(1);
  });
}
