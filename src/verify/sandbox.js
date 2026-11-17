import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Standard test runner prefixes allowed during VERIFY phase.
 */
const ALLOWED_RUNNER_PREFIXES = [
  'npm test',
  'npm run test',
  'node --test',
  'node -e',
  'pytest',
  'python -m unittest',
  'python -m pytest',
  'cargo test',
  'go test',
  'make test',
  'vitest',
  'jest'
];

/**
 * Checks if bubblewrap (bwrap) is available and functional on this system.
 */
let bwrapAvailableCache = null;
export function isBubblewrapAvailable() {
  if (bwrapAvailableCache !== null) return bwrapAvailableCache;
  if (process.platform !== 'linux') {
    bwrapAvailableCache = false;
    return false;
  }
  try {
    const res = spawnSync('bwrap', ['--version'], { encoding: 'utf-8' });
    bwrapAvailableCache = res.status === 0;
  } catch (_) {
    bwrapAvailableCache = false;
  }
  return bwrapAvailableCache;
}

export class KruschSandbox {
  /**
   * Validate that a command is a legitimate test verification command, not an unverified shell escape.
   */
  static validateCapability(command, options = {}) {
    if (!command || typeof command !== 'string') {
      return { allowed: false, reason: 'Command must be a non-empty string.' };
    }

    const trimmed = command.trim();

    // 1. Explicit configured command override from contract takes precedence
    if (options.allowedCommand && trimmed === options.allowedCommand.trim()) {
      return { allowed: true, reason: 'Matched configured contract command' };
    }
    if (options.verificationCommand && trimmed === options.verificationCommand.trim()) {
      return { allowed: true, reason: 'Matched verified project command' };
    }

    // 2. Check standard test runner prefixes
    const matchesStandardRunner = ALLOWED_RUNNER_PREFIXES.some(prefix =>
      trimmed === prefix || trimmed.startsWith(`${prefix} `) || trimmed.startsWith(`${prefix}:`)
    );

    if (matchesStandardRunner) {
      // Reject dangerous shell injection attempts even if prefix matches
      const forbiddenPatterns = [
        /\bcurl\b/i,
        /\bwget\b/i,
        /\brm\s+-rf\s+[\/~]/i,
        /\bsh\s+-i\b/i,
        /\bbash\s+-i\b/i,
        /\bnc\b/i,
        /\bnetcat\b/i
      ];

      for (const pattern of forbiddenPatterns) {
        if (pattern.test(trimmed)) {
          return { allowed: false, reason: `Command contains forbidden dangerous token: ${pattern}` };
        }
      }

      return { allowed: true, reason: 'Matched standard test runner capability' };
    }

    // Reject unverified shell commands
    return {
      allowed: false,
      reason: `Command '${trimmed}' is not an authorized test runner. Allowed capabilities: ${ALLOWED_RUNNER_PREFIXES.join(', ')} or explicit krusch.verify.json command.`
    };
  }

  /**
   * Compute deterministic replay token for this verification run.
   */
  static computeReplayToken(command, fileManifest, envSnapshot) {
    const payload = JSON.stringify({
      command,
      fileManifest: (fileManifest || []).sort((a, b) => a.path.localeCompare(b.path)),
      envSnapshot
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Execute verification command inside the strongest available sandbox:
   * 1. Bubblewrap (bwrap) with unprivileged user namespaces, read-only root/base mounts,
   *    tmpfs scratch, --unshare-net, --unshare-pid, and process group termination.
   * 2. Process Sandbox with process-group kill (-pgid), sanitized env, and staged directory.
   */
  static async run({ command, cwd, stagedDir, stagedDiffs = [], options = {} }) {
    const timeoutMs = options.timeoutMs || 60000;
    const allowNetwork = options.allowNetwork === true;
    const forceProcess = options.forceProcess === true || options.sandbox === false;

    // Capability check
    const capability = KruschSandbox.validateCapability(command, options);
    if (!capability.allowed) {
      const errMessage = `Capability Violation: ${capability.reason}`;
      return {
        command,
        exitCode: 126,
        stdout: '',
        stderr: errMessage,
        passed: false,
        durationMs: 0,
        sandboxType: 'rejected',
        sandboxConfig: {},
        envSnapshot: {},
        fileManifest: [],
        replayToken: null,
        extractedErrors: [{ type: 'CapabilityViolation', message: errMessage }]
      };
    }

    // Build sanitized environment snapshot
    const envSnapshot = {
      CI: 'true',
      FORCE_COLOR: '0',
      NODE_ENV: 'test',
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME || '/tmp'
    };

    // File manifest for replayability
    const fileManifest = stagedDiffs.map(d => ({
      path: d.file_path || d.filePath,
      sha256: d.sha256_hash || d.sha256 || crypto.createHash('sha256').update(d.staged_content || d.content || '').digest('hex')
    }));

    const replayToken = KruschSandbox.computeReplayToken(command, fileManifest, envSnapshot);

    const useBwrap = !forceProcess && options.nodePermission !== true && isBubblewrapAvailable();

    if (useBwrap) {
      return KruschSandbox._runBubblewrap({
        command,
        cwd: stagedDir || cwd,
        projectPath: cwd,
        stagedDir,
        stagedDiffs,
        timeoutMs,
        allowNetwork,
        envSnapshot,
        fileManifest,
        replayToken
      });
    }

    if (
      options.nodePermission === true ||
      (forceProcess && /^node\s+(?!--(?:experimental-)?permission\b)/i.test(command.trim()) && options.nodePermission !== false)
    ) {
      const parsedTokens = [];
      const tokRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = tokRe.exec(command.trim())) !== null) {
        parsedTokens.push(m[1] ?? m[2] ?? m[3]);
      }
      if (parsedTokens[0] === 'node') {
        return KruschSandbox._runNodePermission({
          command,
          nodeArgs: parsedTokens.slice(1),
          cwd: stagedDir || cwd,
          projectPath: cwd,
          extraReadPaths: Array.isArray(options.extraReadPaths) ? options.extraReadPaths : [],
          allowWritePaths: Array.isArray(options.allowWritePaths) ? options.allowWritePaths : [],
          timeoutMs,
          envSnapshot,
          fileManifest,
          replayToken
        });
      }
    }

    return KruschSandbox._runProcessJail({
      command,
      cwd: stagedDir || cwd,
      timeoutMs,
      envSnapshot,
      fileManifest,
      replayToken
    });
  }

  /**
   * Cross-platform Node 22 `--permission` capability jail (`node_permission`)
   * restricting FS reads strictly to the staged workspace + explicit `extraReadPaths`,
   * denying FS writes unless allowed, and stripping host secrets.
   */
  static async _runNodePermission({
    command,
    nodeArgs,
    cwd,
    projectPath,
    extraReadPaths = [],
    allowWritePaths = [],
    timeoutMs,
    envSnapshot,
    fileManifest,
    replayToken
  }) {
    const startTime = Date.now();
    const realCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
    const readSet = new Set([realCwd, path.dirname(process.execPath)]);
    if (projectPath && fs.existsSync(projectPath)) {
      const nmPath = path.join(projectPath, 'node_modules');
      if (fs.existsSync(nmPath)) {
        try {
          readSet.add(fs.realpathSync(nmPath));
        } catch (_) {}
      }
    }
    for (const p of extraReadPaths) {
      if (typeof p === 'string' && fs.existsSync(p)) {
        try {
          readSet.add(fs.realpathSync(p));
        } catch (_) {}
      }
    }

    const writeSet = new Set();
    for (const wp of allowWritePaths) {
      if (typeof wp === 'string' && fs.existsSync(wp)) {
        try {
          writeSet.add(fs.realpathSync(wp));
        } catch (_) {}
      }
    }

    const permFlag = process.allowedNodeEnvironmentFlags?.has('--permission')
      ? '--permission'
      : '--experimental-permission';
    const permArgs = [permFlag];
    for (const rp of readSet) permArgs.push(`--allow-fs-read=${rp}`);
    for (const wp of writeSet) permArgs.push(`--allow-fs-write=${wp}`);
    permArgs.push(...nodeArgs);

    const sandboxConfig = {
      engine: 'node_permission',
      fsReadRestricted: true,
      fsWriteRestricted: writeSet.size === 0,
      childProcessBlocked: true,
      cwd: realCwd
    };

    const minimalEnv = {
      CI: 'true',
      FORCE_COLOR: '0',
      NODE_ENV: 'test',
      NODE_NO_WARNINGS: '1',
      PATH: envSnapshot.PATH
    };

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn(process.execPath, permArgs, {
        cwd: realCwd,
        detached: true,
        shell: false,
        env: minimalEnv
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch (_) {
          try { proc.kill('SIGKILL'); } catch (_) {}
        }
      }, timeoutMs);

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        if (timedOut) {
          resolve({
            command,
            exitCode: -1,
            stdout: stdout.trim(),
            stderr: `${stderr.trim()}\nNode permission sandbox timeout after ${timeoutMs}ms (killed process group).`,
            passed: false,
            durationMs,
            sandboxType: 'node_permission',
            sandboxConfig,
            envSnapshot: minimalEnv,
            fileManifest,
            replayToken
          });
          return;
        }
        resolve({
          command,
          exitCode: exitCode ?? -1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          passed: exitCode === 0,
          durationMs,
          sandboxType: 'node_permission',
          sandboxConfig,
          envSnapshot: minimalEnv,
          fileManifest,
          replayToken
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          command,
          exitCode: -1,
          stdout: stdout.trim(),
          stderr: `Node permission sandbox spawn error: ${err.message}`,
          passed: false,
          durationMs: Date.now() - startTime,
          sandboxType: 'node_permission',
          sandboxConfig,
          envSnapshot: minimalEnv,
          fileManifest,
          replayToken
        });
      });
    });
  }

  /**
   * Bubblewrap sandboxed execution
   */
  static async _runBubblewrap({
    command,
    cwd,
    projectPath,
    stagedDir,
    timeoutMs,
    allowNetwork,
    envSnapshot,
    fileManifest,
    replayToken
  }) {
    const startTime = Date.now();
    const sandboxConfig = {
      engine: 'bwrap',
      networkIsolated: !allowNetwork,
      pidIsolated: true,
      readOnlyMounts: ['/usr', '/lib', '/bin', projectPath],
      tmpfs: ['/tmp'],
      cwd
    };

    const bwrapArgs = [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc'
    ];

    if (!allowNetwork) {
      bwrapArgs.push('--unshare-net');
    }
    bwrapArgs.push('--unshare-pid');
    bwrapArgs.push('--die-with-parent');

    const targetDir = stagedDir || cwd;
    if (targetDir && fs.existsSync(targetDir)) {
      bwrapArgs.push('--bind', targetDir, targetDir);
    }

    bwrapArgs.push('--chdir', cwd);

    // Append command to run via sh inside bwrap
    bwrapArgs.push('--', 'sh', '-c', command);

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const proc = spawn('bwrap', bwrapArgs, {
        cwd,
        detached: true,
        env: envSnapshot
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          // Kill the entire process group
          process.kill(-proc.pid, 'SIGKILL');
        } catch (_) {
          try { proc.kill('SIGKILL'); } catch (_) {}
        }
      }, timeoutMs);

      proc.stdout.on('data', data => { stdout += data.toString(); });
      proc.stderr.on('data', data => { stderr += data.toString(); });

      proc.on('close', exitCode => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        if (timedOut) {
          resolve({
            command,
            exitCode: -1,
            stdout: stdout.trim(),
            stderr: `${stderr.trim()}\nSandbox timeout after ${timeoutMs}ms (killed process group).`,
            passed: false,
            durationMs,
            sandboxType: 'bwrap',
            sandboxConfig,
            envSnapshot,
            fileManifest,
            replayToken
          });
          return;
        }

        resolve({
          command,
          exitCode: exitCode ?? -1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          passed: exitCode === 0,
          durationMs,
          sandboxType: 'bwrap',
          sandboxConfig,
          envSnapshot,
          fileManifest,
          replayToken
        });
      });

      proc.on('error', err => {
        clearTimeout(timer);
        resolve({
          command,
          exitCode: -1,
          stdout: stdout.trim(),
          stderr: `Bubblewrap sandbox spawn error: ${err.message}`,
          passed: false,
          durationMs: Date.now() - startTime,
          sandboxType: 'bwrap',
          sandboxConfig,
          envSnapshot,
          fileManifest,
          replayToken
        });
      });
    });
  }

  /**
   * Process Jail fallback execution with process-group kill
   */
  static async _runProcessJail({
    command,
    cwd,
    timeoutMs,
    envSnapshot,
    fileManifest,
    replayToken
  }) {
    const startTime = Date.now();
    const sandboxConfig = {
      engine: 'process_jail',
      networkIsolated: false,
      pidIsolated: false,
      processGroupKilled: true,
      cwd
    };

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Spawn with detached: true so we get a process group to kill on timeout
      const proc = spawn('sh', ['-c', command], {
        cwd,
        detached: true,
        env: envSnapshot
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch (_) {
          try { proc.kill('SIGKILL'); } catch (_) {}
        }
      }, timeoutMs);

      proc.stdout.on('data', data => { stdout += data.toString(); });
      proc.stderr.on('data', data => { stderr += data.toString(); });

      proc.on('close', exitCode => {
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        if (timedOut) {
          resolve({
            command,
            exitCode: -1,
            stdout: stdout.trim(),
            stderr: `${stderr.trim()}\nProcess jail timeout after ${timeoutMs}ms (killed process group).`,
            passed: false,
            durationMs,
            sandboxType: 'process_jail',
            sandboxConfig,
            envSnapshot,
            fileManifest,
            replayToken
          });
          return;
        }

        resolve({
          command,
          exitCode: exitCode ?? -1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          passed: exitCode === 0,
          durationMs,
          sandboxType: 'process_jail',
          sandboxConfig,
          envSnapshot,
          fileManifest,
          replayToken
        });
      });

      proc.on('error', err => {
        clearTimeout(timer);
        resolve({
          command,
          exitCode: -1,
          stdout: stdout.trim(),
          stderr: `Process jail spawn error: ${err.message}`,
          passed: false,
          durationMs: Date.now() - startTime,
          sandboxType: 'process_jail',
          sandboxConfig,
          envSnapshot,
          fileManifest,
          replayToken
        });
      });
    });
  }
}
