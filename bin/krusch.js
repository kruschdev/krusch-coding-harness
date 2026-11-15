#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

import { KruschStateMachine } from '../src/workflow/state-machine.js';
import { KruschCascadeRouter, DEFAULT_SPECIALISTS } from '../src/router/cascade.js';
import { KruschStateManager } from '../src/brain/state-manager.js';
import { startMcpServer } from '../src/server/mcp-server.js';
import { migrate } from '../db/migrate.js';
import { query, pool, enableEphemeralMode } from '../src/brain/pool.js';
import { HARNESS_PHASES } from '../src/workflow/fsm.js';
import { generateUnifiedDiff } from '../src/utils/diff-patch.js';
import { KruschTelemetry } from '../src/brain/telemetry.js';
import {
  runDoctor,
  startBridgeServer,
  runHeadlessCi,
  runVerifyModels,
  runInvariantDemo,
  runBenchmark,
} from '../src/control/control-plane.js';
import { runTrajectoryEvalGate } from '../src/eval/trajectory-dag-gate.js';

const program = new Command();
const invokedBin = path.basename(process.argv[1] || 'krusch', '.js');
const cliName =
  invokedBin === 'krusch-coding-harness' || invokedBin === 'krusch-harness'
    ? invokedBin
    : 'krusch';

program
  .name(cliName)
  .description('Krusch Coding Harness (krusch-coding-harness) — Postgres-backed coding harness that stages diffs, runs tests, and only then writes the working tree.')
  .version('0.1.0');

// 1. krusch init
program
  .command('init')
  .description('Initialize environment, probe PostgreSQL connection, and apply schema migrations')
  .option('--ephemeral', 'Initialize ephemeral in-process PostgreSQL database (zero setup)', false)
  .action(async (options) => {
    console.log(chalk.bold.cyan('\n🚀 KRUSCH CODING HARNESS INITIALIZATION (v0.1.0)\n'));

    if (options.ephemeral) {
      enableEphemeralMode();
      console.log(chalk.bold.green('✓ Initialized ephemeral in-process PostgreSQL 16 (PGlite)'));
      console.log(chalk.green('✓ All schema migrations applied in-process.'));
      console.log(chalk.gray('  Run a mock task: ./bin/krusch.js run "your task" --mock --ephemeral\n'));
      process.exit(0);
    }

    const rootDir = path.resolve(__dirname, '..');
    const envPath = path.join(rootDir, '.env');
    const envExamplePath = path.join(rootDir, '.env.example');

    // 1. Check or write .env
    if (!fs.existsSync(envPath)) {
      if (fs.existsSync(envExamplePath)) {
        fs.copyFileSync(envExamplePath, envPath);
        console.log(chalk.green('✓ Created .env from .env.example'));
      } else {
        const defaultEnv = 'DATABASE_URL=postgresql://postgres:postgres@localhost:5432/krusch\nKRUSCH_AUTO_APPROVE=false\nKRUSCH_LEASE_TTL_MINUTES=15\n';
        fs.writeFileSync(envPath, defaultEnv, 'utf-8');
        console.log(chalk.green('✓ Created default .env'));
      }
    } else {
      console.log(chalk.gray('✓ Found existing .env file'));
    }

    // Reload dotenv
    dotenv.config({ path: envPath, override: true, quiet: true });
    const dbUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/krusch';
    console.log(chalk.gray(`  Database Target: ${dbUrl.replace(/:[^:@]+@/, ':****@')}`));

    // 2. Probe PostgreSQL Connectivity
    process.stdout.write('  Probing PostgreSQL connectivity... ');
    try {
      const probeRes = await query('SELECT version(), current_database()');
      const pgVer = probeRes.rows[0]?.version?.split(' ')?.[1] || 'unknown';
      const currentDb = probeRes.rows[0]?.current_database || 'unknown';
      console.log(chalk.bold.green(`CONNECTED (PostgreSQL ${pgVer}, DB: ${currentDb})`));
    } catch (err) {
      console.log(chalk.bold.red('FAILED'));
      console.error(chalk.red(`\n✗ Could not connect to PostgreSQL: ${err.message}`));
      console.log(chalk.yellow('\nTroubleshooting:'));
      console.log('  1. Ensure PostgreSQL is running: `docker compose up -d`');
      console.log('  2. Verify DATABASE_URL in .env matches your credentials');
      console.log('  3. Or run in zero-setup ephemeral mode: `./bin/krusch.js run "<goal>" --mock --ephemeral`\n');
      process.exit(1);
    }

    // 3. Run Migrations
    console.log('\n  Checking & applying database migrations:');
    try {
      await migrate();

      // 4. Run Startup Crash Recovery & Lease Pruning
      const recovered = await KruschStateManager.recoverInFlightApplies(process.cwd());
      if (recovered.length > 0) {
        console.log(chalk.yellow(`  ✓ Recovered ${recovered.length} in-flight diff apply operation(s)`));
      }
      const pruned = await KruschStateManager.pruneExpiredLeases();
      if (pruned.length > 0) {
        console.log(chalk.yellow(`  ✓ Pruned ${pruned.length} expired file concurrency lease(s)`));
      }

      console.log(chalk.bold.green('\n✓ Krusch harness is fully initialized and ready!'));
      console.log(chalk.gray('  Run a task:   ./bin/krusch.js run "your task description" --mock'));
      console.log(chalk.gray('  Start MCP:    ./bin/krusch.js mcp\n'));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Initialization failed: ${err.message}\n`));
      process.exit(1);
    }
  });

// 2. krusch run
program
  .command('run <goal>')
  .description('Execute an engineering task through the Krusch invariant harness')
  .option('-m, --model <id>', 'Override model specialist')
  .option('-t, --max-turns <turns>', 'Maximum turns budget', '10')
  .option('-a, --auto-approve', 'Automatically approve staged diffs and actions', false)
  .option('-c, --test-cmd <command>', 'Explicit ground-truth test/verification command override')
  .option('--mock', 'Run with local deterministic mock adapter (zero cloud API keys needed)', false)
  .option('--ephemeral', 'Run with throwaway in-process PostgreSQL database (zero external setup)', false)
  .action(async (goal, options) => {
    if (options.ephemeral) {
      enableEphemeralMode();
    }

    console.log(chalk.bold.cyan('\n⚡ KRUSCH CODING HARNESS ⚡'));
    console.log(chalk.gray(`Goal: "${goal}"`));
    console.log(chalk.gray(`Substrate: PostgreSQL (${options.ephemeral ? 'in-process PGlite WASM' : (process.env.DATABASE_URL || 'default').replace(/:[^:@]+@/, ':****@')})`));
    if (options.testCmd) {
      console.log(chalk.gray(`Test Command: "${options.testCmd}"`));
    }
    if (options.mock) {
      console.log(chalk.yellow('Mode: Local Deterministic Mock Adapter (Offline/Demo)'));
    }

    const harness = new KruschStateMachine({
      autoApprove: options.autoApprove,
      useMock: options.mock,
      simulateMockTrajectory: options.mock,
      pinnedModel: options.model
    });

    try {
      const result = await harness.runTask({
        goal,
        projectPath: process.cwd(),
        maxTurns: parseInt(options.maxTurns, 10),
        modelOverride: options.model,
        verificationCommand: options.testCmd || null,
      });

      console.log('\n' + chalk.bold.green('✓ Task Execution Finished:'));
      console.log(`  Task ID:        ${chalk.yellow(result.taskId)}`);
      console.log(`  Final Phase:    ${chalk.cyan(result.status)}`);
      if (result.reason) {
        console.log(`  Reason:         ${chalk.yellow(result.reason)}`);
      }
      console.log(`  Turns Executed: ${result.turnsExecuted}`);
      console.log(`  Staged Diffs:   ${result.stagedDiffsCount}`);
      console.log(`  Final Model:    ${chalk.magenta(result.finalModel)}`);

      // Human-in-the-loop interactive approval gate prompt if diffs are pending
      if (result.status === HARNESS_PHASES.APPROVAL_GATE && !options.autoApprove && result.stagedDiffsCount > 0) {
        console.log(chalk.yellow(`\n⚠️  Task is waiting in APPROVAL_GATE with ${result.stagedDiffsCount} verified staged diff(s).`));
        console.log(`Run ${chalk.cyan(`./bin/krusch.js diff ${result.taskId}`)} to inspect the diffs.`);

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(resolve => {
          rl.question(chalk.bold('Approve and apply staged diffs to working tree now? [y/N]: '), ans => {
            rl.close();
            resolve(ans.trim().toLowerCase());
          });
        });

        if (answer === 'y' || answer === 'yes') {
          console.log(chalk.gray('Applying staged diffs...'));
          const batchRes = await KruschStateManager.applyDiffBatch(result.taskId, null, process.cwd());
          await KruschStateManager.updateTask(result.taskId, { phase: HARNESS_PHASES.COMMITTED });
          console.log(chalk.bold.green(`✓ Successfully applied ${batchRes.appliedCount} file(s) to working tree. Task COMMITTED.`));
        } else {
          console.log(chalk.gray('Diffs remain safely staged in PostgreSQL. Working tree untouched.'));
        }
      }
      console.log();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Harness Execution Error: ${err.message}`));
      process.exit(1);
    }
  });

// 3. krusch route
program
  .command('route <prompt>')
  .description('Inspect cascade router decision for a prompt without executing it')
  .action((prompt) => {
    const router = new KruschCascadeRouter();
    const route = router.route(prompt);
    console.log(chalk.bold.cyan('\n🎯 Cascade Router Dispatch Decision:'));
    console.log(`  Stage:       ${chalk.green(route.stage)}`);
    console.log(`  Model:       ${chalk.yellow(route.modelId)}`);
    console.log(`  Role:        ${chalk.magenta(route.role)}`);
    console.log(`  Confidence:  ${route.confidence}`);
    console.log(`  Cost Est:    ${chalk.cyan(route.costEstimate || 'N/A')}`);
    console.log(`  Latency:     ${route.latencyMs}ms`);
    console.log(`  Rationale:   ${chalk.gray(route.rationale)}\n`);
    process.exit(0);
  });

// 4. krusch models
program
  .command('models')
  .description('List current specialist model pool and routing mappings')
  .action(() => {
    console.log(chalk.bold.cyan('\n📋 Active Specialist Model Pool:'));
    for (const [role, model] of Object.entries(DEFAULT_SPECIALISTS)) {
      console.log(`  ${chalk.bold(role.padEnd(16))}: ${chalk.yellow(model)}`);
    }
    console.log();
    process.exit(0);
  });

// 5. krusch status
program
  .command('status <taskId>')
  .description('Inspect task execution details, turns, staged diffs, and verification trace from PostgreSQL')
  .option('--trace', 'Print complete chronological event timeline', false)
  .option('--json', 'Output complete OpenTelemetry-compatible JSON trace with cost ledger', false)
  .option('--export <file>', 'Export complete machine-readable execution trace to JSON file')
  .action(async (taskId, options) => {
    try {
      const task = await KruschStateManager.getTask(taskId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        process.exit(1);
      }

      // Query apply journal entries for this task
      const journalRes = await query(
        'SELECT id, state, files, created_at, completed_at, error_message FROM krusch_apply_journal WHERE task_id = $1 ORDER BY id ASC',
        [taskId]
      );

      if (options.json) {
        const trace = KruschTelemetry.buildTrace({
          ...task,
          applyJournals: journalRes.rows
        });
        console.log(JSON.stringify(trace, null, 2));
        process.exit(0);
      }

      console.log(chalk.bold.cyan(`\n📦 Task Status: ${task.id}`));
      console.log(`  Goal:          ${task.goal}`);
      console.log(`  Phase:         ${chalk.yellow(task.phase)}`);
      if (task.metadata && task.metadata.reason) {
        console.log(`  Reason:        ${chalk.red(task.metadata.reason)}`);
      }
      console.log(`  Active Model:  ${task.current_model || 'none'}`);
      console.log(`  Turns:         ${task.turns.length}`);
      console.log(`  Staged Diffs:  ${task.stagedDiffs.length}`);
      console.log(`  Approvals:     ${task.approvals.length}`);
      console.log(`  Verifications: ${task.verifications.length}`);

      if (journalRes.rows.length > 0) {
        console.log(chalk.bold('\n  2PC Apply Journal:'));
        for (const j of journalRes.rows) {
          const stateColor = j.state === 'APPLIED' ? chalk.green(j.state) : j.state === 'APPLYING' ? chalk.yellow(j.state) : chalk.red(j.state);
          console.log(`    - Journal #${j.id} [${stateColor}] at ${new Date(j.created_at).toISOString().slice(11, 19)}`);
        }
      }

      // Default Status View: Transition Feasibility & Blockers with SQL Invariant Names
      const explanation = await KruschStateManager.explainTaskStatus(taskId);
      console.log(chalk.bold.cyan('\n🔍 State Feasibility & Invariant Invariants:'));
      for (const t of explanation.possibleTransitions) {
        const isBlocked = t.reason.startsWith('BLOCKED');
        const prefix = isBlocked ? chalk.red('  ✗') : chalk.green('  ✓');
        console.log(`${prefix} ${chalk.bold(`${t.from} ➔ ${t.to}`)}: ${isBlocked ? chalk.red(t.reason) : chalk.gray(t.reason)}`);
      }

      // Query complete event timeline
      const eventsRes = await query(
        'SELECT id, event_type, payload, created_at FROM krusch_events WHERE task_id = $1 ORDER BY id ASC',
        [taskId]
      );

      if (options.trace) {
        console.log(chalk.bold.cyan('\n⏱️ Chronological Event Timeline:'));
        if (eventsRes.rows.length === 0) {
          console.log(chalk.gray('  No events recorded.'));
        } else {
          for (const ev of eventsRes.rows) {
            const time = new Date(ev.created_at).toISOString().slice(11, 19);
            console.log(`  [${chalk.gray(time)}] ${chalk.bold.magenta(ev.event_type.padEnd(20))}: ${chalk.gray(JSON.stringify(ev.payload))}`);
          }
        }

        if (explanation.latestVerification) {
          const lv = explanation.latestVerification;
          const statusStr = lv.passed ? chalk.green('PASSED (exit 0)') : chalk.red(`FAILED (exit ${lv.exitCode})`);
          console.log(chalk.bold('\n  Verification Run:'));
          console.log(`    Status:   ${statusStr}`);
          console.log(`    Command:  "${lv.command}"`);
          if (lv.failureModule) {
            console.log(`    Module:   ${chalk.magenta(lv.failureModule)}`);
          }
        }

        if (task.stagedDiffs.length > 0) {
          console.log(chalk.bold('\n  Staged Diffs & Leases:'));
          for (const d of task.stagedDiffs) {
            const statusColor = d.status === 'APPLIED' || d.status === 'COMMITTED'
              ? chalk.green(d.status)
              : d.status === 'PENDING' || d.status === 'APPLYING'
                ? chalk.yellow(d.status)
                : chalk.red(d.status);
            console.log(`    - ID ${d.id}: ${chalk.bold(d.file_path)} [${statusColor}]`);
            console.log(`      SHA-256: ${d.sha256_hash ? d.sha256_hash.slice(0, 16) + '...' : 'none'}`);
            if (d.lease_expires_at) {
              const remaining = Math.round((new Date(d.lease_expires_at).getTime() - Date.now()) / 1000);
              console.log(`      Lease TTL: ${remaining > 0 ? `${remaining}s remaining` : chalk.red('EXPIRED')}`);
            }
          }
        }
      }

      // Handle --export <file>
      if (options.export) {
        const fullTrace = {
          taskId: task.id,
          goal: task.goal,
          phase: task.phase,
          currentModel: task.current_model,
          metadata: task.metadata,
          turns: task.turns,
          stagedDiffs: task.stagedDiffs,
          verifications: task.verifications,
          approvals: task.approvals,
          applyJournals: journalRes.rows,
          events: eventsRes.rows,
          exportedAt: new Date().toISOString()
        };
        const exportPath = path.resolve(process.cwd(), options.export);
        fs.writeFileSync(exportPath, JSON.stringify(fullTrace, null, 2), 'utf-8');
        console.log(chalk.bold.green(`\n✓ Full execution trace exported to: ${exportPath}`));
      }

      console.log();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Error inspecting task: ${err.message}`));
      process.exit(1);
    }
  });

// 6. krusch explain
program
  .command('explain <taskId>')
  .description('Explain why transitions or actions are allowed or blocked for a task')
  .action(async (taskId) => {
    try {
      const exp = await KruschStateManager.explainTaskStatus(taskId);
      if (!exp) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        process.exit(1);
      }
      console.log('\n' + KruschStateManager.formatExplainOutput(exp) + '\n');
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Error explaining task: ${err.message}`));
      process.exit(1);
    }
  });

// 7. krusch diff
program
  .command('diff <taskId>')
  .description('Display or export PR-ready unified diffs of all staged modifications for a task')
  .option('-e, --export <filePath>', 'Export unified diff directly to a patch file')
  .action(async (taskId, options) => {
    try {
      const task = await KruschStateManager.getTask(taskId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        process.exit(1);
      }

      if (task.stagedDiffs.length === 0) {
        console.log(chalk.yellow(`No staged diffs found for task ${taskId}.`));
        process.exit(0);
      }

      let fullPatch = '';
      for (const diff of task.stagedDiffs) {
        const patchStr = generateUnifiedDiff(
          diff.file_path,
          diff.original_content || '',
          diff.staged_content || ''
        );
        if (patchStr) {
          fullPatch += patchStr;
        }
      }

      if (options.export) {
        fs.writeFileSync(options.export, fullPatch, 'utf-8');
        console.log(chalk.green(`✓ Exported PR-ready unified diff patch to ${options.export}`));
      } else {
        console.log(chalk.bold.cyan(`\n📝 Staged Diffs for Task ${taskId}:\n`));
        const lines = fullPatch.split('\n');
        for (const line of lines) {
          if (line.startsWith('+') && !line.startsWith('+++')) {
            console.log(chalk.green(line));
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            console.log(chalk.red(line));
          } else if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git')) {
            console.log(chalk.cyan(line));
          } else {
            console.log(line);
          }
        }
        console.log();
      }
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Error generating diff: ${err.message}`));
      process.exit(1);
    }
  });

// 8. krusch abort
program
  .command('abort <taskId>')
  .description('Explicitly abort an active task and release all held file concurrency leases')
  .option('-r, --reason <reason>', 'Rationale for aborting', 'Aborted by operator')
  .action(async (taskId, options) => {
    try {
      const res = await KruschStateManager.abortTask(taskId, options.reason);
      console.log(chalk.bold.yellow(`\n✓ Task ${res.taskId} transitioned to ABORTED.`));
      console.log(`  Reason: ${chalk.gray(res.reason)}`);
      console.log(chalk.green('  All associated file concurrency leases released.\n'));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Error aborting task: ${err.message}\n`));
      process.exit(1);
    }
  });

// 9. krusch retry
program
  .command('retry <taskId>')
  .description('Unstick and retry an aborted or failed task from a designated phase (PLAN, IMPLEMENT, VERIFY)')
  .option('-p, --from <phase>', 'Phase to resume from', 'VERIFY')
  .option('-r, --reason <reason>', 'Rationale for retry', 'Retried by operator')
  .action(async (taskId, options) => {
    try {
      const res = await KruschStateManager.retryTask(taskId, options.from, options.reason);
      console.log(chalk.bold.green(`\n✓ Task ${res.taskId} reset to phase: ${res.status}`));
      console.log(`  Reason: ${chalk.gray(res.reason)}`);
      console.log(chalk.gray('  Phase revisit counter reset to 0.\n'));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Error retrying task: ${err.message}\n`));
      process.exit(1);
    }
  });

// 10. krusch reject
program
  .command('reject <taskId> [diffId]')
  .description('Reject staged diffs for a task, preventing apply and releasing leases')
  .option('-r, --reason <reason>', 'Rationale for rejection', 'Rejected by operator')
  .action(async (taskId, diffId, options) => {
    try {
      const parsedDiffId = diffId ? parseInt(diffId, 10) : null;
      const res = await KruschStateManager.rejectStagedDiff(taskId, parsedDiffId, options.reason);
      console.log(chalk.bold.yellow(`\n✓ Marked staged diff(s) as REJECTED for task ${res.taskId}.`));
      if (res.diffId) {
        console.log(`  Diff ID: ${res.diffId}`);
      }
      console.log(`  Reason:  ${chalk.gray(res.reason)}\n`);
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Error rejecting diff: ${err.message}\n`));
      process.exit(1);
    }
  });

// 8. krusch lease
const leaseCommand = program.command('lease').description('Inspect and manage single-writer file concurrency leases');

leaseCommand
  .command('list')
  .description('List all active file concurrency leases across tasks')
  .action(async () => {
    try {
      const leases = await KruschStateManager.listActiveLeases();
      if (leases.length === 0) {
        console.log(chalk.green('\n✓ No active file leases currently held.\n'));
        process.exit(0);
      }
      console.log(chalk.bold.cyan(`\n🔒 Active Single-Writer File Leases (${leases.length}):\n`));
      for (const l of leases) {
        const remainingStr = l.is_expired
          ? chalk.red('EXPIRED')
          : (l.seconds_remaining != null ? `${l.seconds_remaining}s remaining` : chalk.gray('permanent/none'));
        console.log(`  File:    ${chalk.bold(l.file_path)}`);
        console.log(`  Task:    ${chalk.yellow(l.task_id)}`);
        console.log(`  Status:  ${chalk.magenta(l.status)}`);
        console.log(`  Expires: ${remainingStr}\n`);
      }
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Error listing leases: ${err.message}`));
      process.exit(1);
    }
  });

leaseCommand
  .command('unlock <filePath>')
  .description('Manually release a held lease on a file')
  .option('-t, --task <taskId>', 'Specific holding task ID')
  .action(async (filePath, options) => {
    try {
      const leases = await KruschStateManager.listActiveLeases();
      const target = leases.find(l => l.file_path === filePath && (!options.task || l.task_id === options.task));
      if (!target) {
        console.log(chalk.yellow(`No active lease found for file '${filePath}'.`));
        process.exit(0);
      }

      await KruschStateManager.releaseLease(target.task_id, filePath);
      console.log(chalk.green(`✓ Successfully released lease on '${filePath}' held by task '${target.task_id}'.`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Error releasing lease: ${err.message}`));
      process.exit(1);
    }
  });

leaseCommand
  .command('prune')
  .description('Prune all expired leases past their TTL')
  .action(async () => {
    try {
      const pruned = await KruschStateManager.pruneExpiredLeases();
      console.log(chalk.green(`✓ Pruned ${pruned.length} expired lease(s).`));
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`Error pruning leases: ${err.message}`));
      process.exit(1);
    }
  });

// 9. krusch mcp
program
  .command('mcp')
  .description('Start Model Context Protocol (MCP) server over stdio')
  .action(async () => {
    await startMcpServer();
  });

// 10. krusch migrate
program
  .command('migrate')
  .description('Run PostgreSQL schema migrations for Krusch')
  .action(async () => {
    await migrate();
    process.exit(0);
  });

// 11. krusch doctor (alias: health)
program
  .command('doctor [sibling]')
  .alias('health')
  .description('Run unified 3-Tier ecosystem & PostgreSQL control-plane healthcheck')
  .action(async (sibling) => {
    const ok = await runDoctor({ sibling });
    process.exit(ok ? 0 : 1);
  });

// 12. krusch serve (alias: up)
program
  .command('serve')
  .alias('up')
  .description('Start HTTP Software Factory Control Room & control-plane bridge daemon (default: 127.0.0.1:3778)')
  .option('-p, --port <port>', 'Bridge HTTP port', '3778')
  .option('-H, --host <host>', 'Bridge bind host', '127.0.0.1')
  .option('--ephemeral', 'Run with throwaway in-process PostgreSQL database (zero external setup)', false)
  .action(async (options) => {
    try {
      if (options.ephemeral) {
        enableEphemeralMode();
      }
      await migrate();
      await KruschStateManager.recoverInFlightApplies();
      await KruschStateManager.pruneExpiredLeases();
    } catch (_) {}
    startBridgeServer({ port: parseInt(options.port, 10), host: options.host });
  });

// 13. krusch ci
program
  .command('ci [projectPath]')
  .description('Execute headless CI staging, sandboxed verification, and 2PC atomic apply')
  .option('--patch <file>', 'JSON patch manifest to stage and verify')
  .option('--goal <goal>', 'Task goal description', 'Headless CI Automated Verification')
  .action(async (projectPath, options) => {
    try {
      await runHeadlessCi(projectPath || process.cwd(), options);
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Headless CI Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// 14. krusch verify-models
program
  .command('verify-models')
  .description('Verify zero-context-loss prefix parity across Claude, Gemini, and Ollama')
  .action(async () => {
    try {
      await runVerifyModels();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Model Switch Verification Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// 15. krusch demo-invariant
program
  .command('demo-invariant')
  .description('Execute 7-step write invariant & working-tree drift refusal proof')
  .action(async () => {
    try {
      await runInvariantDemo();
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Write Invariant Proof Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// 16. krusch bench
program
  .command('bench')
  .description('Run operational benchmarks for 2PC atomic apply and drift refusal')
  .option('-i, --iterations <count>', 'Number of benchmark iterations', '15')
  .action(async (options) => {
    try {
      await runBenchmark({ iterations: parseInt(options.iterations, 10) });
      process.exit(0);
    } catch (err) {
      console.error(chalk.red(`\n✗ Benchmark Error: ${err.message}\n`));
      process.exit(1);
    }
  });

// 17. krusch eval-trajectories
program
  .command('eval-trajectories')
  .description('Replay golden agent trajectories and block CI if tool-call sequences deviate from the Golden DAG')
  .option('-f, --fixture <path>', 'Custom trajectory JSON fixture path')
  .option('-m, --min-count <count>', 'Minimum required trajectory count', '100')
  .option('--strict', 'Exit non-zero on any DAG violation or fixture shrinkage', true)
  .option('--json', 'Emit raw JSON evaluation envelope', false)
  .action((options) => {
    try {
      const report = runTrajectoryEvalGate({
        fixturePath: options.fixture ? path.resolve(options.fixture) : undefined,
        minRequiredCount: parseInt(options.minCount, 10) || 100,
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(chalk.bold.cyan('\n🛡️  KRUSCH GOLDEN DAG TRAJECTORY CI GATE\n'));
        console.log(`  Status    : ${report.ok ? chalk.bold.green('PASSED') : chalk.bold.red('BLOCKED')}`);
        console.log(`  Summary   : ${report.summary}`);
        console.log(`  Evaluated : ${report.data.passed}/${report.data.total} (${(report.data.passRate * 100).toFixed(2)}%)`);
        if (report.data.failures && report.data.failures.length > 0) {
          console.log(chalk.red('\n  Golden DAG Violations:'));
          for (const fail of report.data.failures.slice(0, 10)) {
            const formatted = (fail.violations || [])
              .map((v) => (typeof v === 'string' ? v : `${v.rule}: ${v.message}`))
              .join('; ');
            console.log(chalk.red(`    ✗ [${fail.id}] (${fail.category}): ${formatted}`));
          }
        }
        console.log('');
      }

      process.exit(report.ok ? 0 : 1);
    } catch (err) {
      console.error(chalk.red(`\n✗ Trajectory Eval CI Gate Error: ${err.message}\n`));
      process.exit(1);
    }
  });

program.parse(process.argv);
