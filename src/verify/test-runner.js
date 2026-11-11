import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

export class KruschTestRunner {
  /**
   * Detect the ground-truth test command for a project repository.
   */
  static detectTestCommand(projectPath = process.cwd(), options = {}) {
    // 0. Explicit option or environment override takes top precedence
    if (options.verificationCommand) {
      return options.verificationCommand;
    }
    if (process.env.KRUSCH_TEST_COMMAND) {
      return process.env.KRUSCH_TEST_COMMAND;
    }

    // 1. Node.js (package.json scripts.test)
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        // If testing against the krusch harness repo itself, default to the fast unit suite
        // to avoid infinite recursion or running long-running database integration tests
        if (pkg.name === 'krusch-coding-harness' || pkg.name === 'krusch') {
          return 'npm run test:unit';
        }
        if (pkg.scripts && pkg.scripts.test) {
          const testScript = pkg.scripts.test.trim();
          if (!testScript.includes('no test specified')) {
            return 'npm test';
          }
        }
      } catch (_) {}
    }

    // 2. Python (pytest or unittest)
    if (
      fs.existsSync(path.join(projectPath, 'pytest.ini')) ||
      fs.existsSync(path.join(projectPath, 'pyproject.toml')) ||
      fs.existsSync(path.join(projectPath, 'setup.py')) ||
      fs.existsSync(path.join(projectPath, 'tests'))
    ) {
      return 'pytest';
    }

    // 3. Rust (Cargo.toml)
    if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) {
      return 'cargo test';
    }

    // 4. Go (go.mod)
    if (fs.existsSync(path.join(projectPath, 'go.mod'))) {
      return 'go test ./...';
    }

    // 5. Makefile
    if (fs.existsSync(path.join(projectPath, 'Makefile'))) {
      return 'make test';
    }

    return null;
  }

  /**
   * Parse stdout and stderr to extract structured error diagnostics.
   */
  static parseErrors(stdout = '', stderr = '') {
    const combined = `${stdout}\n${stderr}`;
    const errors = [];
    const lines = combined.split('\n');

    const fileLineRegex = /([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]+):(\d+)(?::(\d+))?/;
    const assertionRegex = /(AssertionError|Assertion failed|expected .+ received .+)/i;
    const syntaxRegex = /(SyntaxError|ReferenceError|TypeError|Error): (.+)/i;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const syntaxMatch = line.match(syntaxRegex);
      if (syntaxMatch) {
        const fileMatch = line.match(fileLineRegex) || (lines[i + 1] && lines[i + 1].match(fileLineRegex));
        errors.push({
          type: syntaxMatch[1],
          message: syntaxMatch[2].trim(),
          file: fileMatch ? fileMatch[1] : null,
          line: fileMatch ? parseInt(fileMatch[2], 10) : null
        });
        continue;
      }

      const assertMatch = line.match(assertionRegex);
      if (assertMatch) {
        const fileMatch = line.match(fileLineRegex) || (lines[i + 1] && lines[i + 1].match(fileLineRegex));
        errors.push({
          type: 'AssertionError',
          message: line.trim(),
          file: fileMatch ? fileMatch[1] : null,
          line: fileMatch ? parseInt(fileMatch[2], 10) : null
        });
      }
    }

    return errors.slice(0, 10);
  }

  /**
   * Run a test or lint command and capture structured ground truth.
   */
  static async runCommand(command, cwd = process.cwd(), options = {}) {
    const timeoutMs = typeof options === 'number' ? options : (options.timeoutMs || 60000);
    const retryFlakes = typeof options === 'object' ? (options.retryFlakes || 0) : 0;

    const executeOnce = () => new Promise((resolve) => {
      const startTime = Date.now();
      const argv = [];
      const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let match;
      while ((match = tokenRe.exec(String(command || ''))) !== null) {
        argv.push(match[1] ?? match[2] ?? match[3]);
      }
      const bin = argv[0] || 'true';
      const proc = spawn(bin, argv.slice(1), {
        cwd,
        shell: false,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0' }
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({
          command,
          exitCode: -1,
          stdout,
          stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms.`,
          passed: false,
          durationMs: Date.now() - startTime
        });
      }, timeoutMs);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        const passed = exitCode === 0;
        resolve({
          command,
          exitCode: exitCode ?? -1,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          passed,
          durationMs: Date.now() - startTime
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          command,
          exitCode: -1,
          stdout,
          stderr: err.message,
          passed: false,
          durationMs: Date.now() - startTime
        });
      });
    });

    let result = await executeOnce();

    // Flake retry if configured
    if (!result.passed && retryFlakes > 0) {
      const retryResult = await executeOnce();
      if (retryResult.passed) {
        result = retryResult;
        result.retried = true;
      }
    }

    result.extractedErrors = KruschTestRunner.parseErrors(result.stdout, result.stderr);
    return result;
  }
}
