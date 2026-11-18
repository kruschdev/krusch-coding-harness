# Install `krusch-coding-harness`

These are instructions for a coding agent (Claude Code, Codex, Cursor, Windsurf, or Antigravity) that a person asked to install and configure `krusch-coding-harness` on their machine or inside their repository.

`krusch-coding-harness` (`v0.1.0`) is a PostgreSQL-backed headless coding harness that stages proposed file diffs into content-addressed tables, runs isolated verification inside Bubblewrap (`bwrap`) or a process-group jail, gates risky mutations behind approvals, and commits verified batches via a crash-recoverable 2PC write-ahead journal. It exposes a CLI (`krusch-coding-harness`, `krusch-harness`, `krusch`), an HTTP Control Bridge (`127.0.0.1:3778`), a 100-trajectory Golden DAG CI gate, and a 7-tool stdio MCP server.

## 1. Check Prerequisites First (All at Once)

Run one read-only check before making any changes:

```bash
id -u
node -v 2>/dev/null || echo "MISSING: node"
npm -v 2>/dev/null || echo "MISSING: npm"
git --version 2>/dev/null || echo "MISSING: git"
docker compose version 2>/dev/null || echo "OPTIONAL_MISSING: docker-compose"
bwrap --version 2>/dev/null || echo "OPTIONAL_MISSING: bwrap"
```

Evaluate the results:
1. **User check**: If `id -u` prints `0` (root), stop and ask the person to run you under a standard non-root developer account.
2. **Node.js `>= 20.0.0` (`v22` LTS recommended)**: Required for native ESM, in-process `PGlite` WASM verification, and MCP stdio transport. If `node -v` is missing or below `v20.0.0`, ask the person before installing or switching Node versions (`nvm install 22` or `fnm use 22`).
3. **Docker Compose & Bubblewrap (`bwrap`) (Strictly Optional)**: Neither is needed for Mode A. `PGlite` runs PostgreSQL 16 in-memory with zero containers, and verification falls back to an isolated process-group jail when `bwrap` is absent (for example on macOS or minimal Linux environments). Only use Docker when the person asks for Mode B's persistent PostgreSQL 16 daemon.

## 2. Choose the Right Setup Mode

- **Mode A: Zero-Postgres, Zero-API-Key Local `PGlite` Verification & Ephemeral CLI (Recommended Default)**: Installs dependencies via `npm ci`, runs the 52 fast unit tests, replays all 100 golden trajectories across 10 failure categories, checks TypeScript declarations, and executes a complete end-to-end ephemeral `PGlite` harness run at `$0.00` with zero Docker containers or API keys.
- **Mode B: Full PostgreSQL 16 + Bubblewrap 5-Step Crash-Recovery & `:3778` HTTP Bridge / 7-Tool MCP Server**: Starts `postgres:16-alpine` via `docker compose up -d`, runs all 11 SQL schema and row-lock invariant migrations (`npm run migrate`), executes all 118 unit and PostgreSQL integration tests (`npm test`), and runs the live 5-step `SIGKILL` mid-apply crash-recovery loop (`node scripts/demo-full-harness-loop.mjs`).

## 3. Install & Verify

### Mode A: Zero-Postgres, Zero-API-Key Local `PGlite` Verification (Default)

Check `pwd` first. Clone into the current directory (or into `~/src/krusch-coding-harness` if the current directory is `$HOME` or another unrelated repository):

```bash
git clone https://github.com/kruschdev/krusch-coding-harness.git
cd krusch-coding-harness
npm ci
[ -f .env ] || cp .env.example .env

# 1. Run 52 fast unit tests (AST indexer, router heuristics, Slack HITL, cost kill-switch, SSRF fallback, policy floor)
npm run test:unit

# 2. Replay all 100 golden trajectories across 10 categories
npm run eval:trajectories

# 3. Verify TypeScript .d.ts declarations and run a complete ephemeral PGlite task
npm run typecheck
./bin/krusch-coding-harness.js run "Verify arithmetic module fix" --mock --ephemeral --auto-approve
```

### Mode B: Full PostgreSQL 16 + Bubblewrap Crash-Recovery & `:3778` Bridge (When Requested)

Only run Mode B if Docker is running and the person asked for persistent PostgreSQL state, crash-recovery testing, or the `:3778` HTTP Control Bridge. Check whether port `5432` or `3778` is already bound first (`ss -ltnp | grep -E ':(5432|3778)\b' || true`):

```bash
git clone https://github.com/kruschdev/krusch-coding-harness.git
cd krusch-coding-harness
npm ci
[ -f .env ] || cp .env.example .env

# 1. Start PostgreSQL 16 (defaults to postgresql://postgres:postgres@localhost:5432/krusch)
docker compose up -d

# 2. Apply all 11 SQL schema & row-lock invariant migrations
npm run migrate

# 3. Run all 118 unit, ephemeral, and PostgreSQL integration tests (includes real SIGKILL crash test)
npm test

# 4. Run the live 5-step stage -> fail -> repair -> SIGKILL recovery -> apply loop
node scripts/demo-full-harness-loop.mjs
```

If the person also wants the loopback HTTP Control Bridge running on `127.0.0.1:3778`:

```bash
./bin/krusch-coding-harness.js doctor
./bin/krusch-coding-harness.js serve --port 3778 --host 127.0.0.1
```

## 4. Connect to the Person's Coding Agent / IDE

`krusch-coding-harness` exposes a frozen 7-tool stdio MCP server (`krusch_run`, `krusch_task_status`, `krusch_diff`, `krusch_apply_diff`, `krusch_explain`, `krusch_reject`, `krusch_abort`) via `node /absolute/path/to/krusch-coding-harness/bin/krusch.js mcp` (or `npm run mcp`).

Replace `/absolute/path/to/krusch-coding-harness` below with the real checkout path returned by `pwd`, and merge the `krusch-harness` server entry into the person's existing IDE configuration without removing other MCP servers:

- **Claude Code CLI**:
  ```bash
  claude mcp add krusch-harness -- node /absolute/path/to/krusch-coding-harness/bin/krusch.js mcp
  ```
- **Cursor (`~/.cursor/mcp.json`), Windsurf (`~/.codeium/windsurf/mcp_config.json`), or Antigravity (`~/.gemini/antigravity/mcp_config.json`)**:
  ```json
  {
    "mcpServers": {
      "krusch-harness": {
        "command": "node",
        "args": ["/absolute/path/to/krusch-coding-harness/bin/krusch.js", "mcp"]
      }
    }
  }
  ```
- **Codex (`~/.codex/config.toml`)**:
  ```toml
  [mcp_servers.krusch-harness]
  command = "node"
  args = ["/absolute/path/to/krusch-coding-harness/bin/krusch.js", "mcp"]
  ```

## Never

- **Never run `npm`, `node`, or `krusch-coding-harness` with `sudo` or as `root`**.
- **Never overwrite an existing `.env` or global MCP config file** (`~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json`, `~/.codex/config.toml`); read the file first, parse it, insert or update only the `krusch-harness` entry, and write it back cleanly.
- **Never invent API keys** (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) in `.env`; leave them blank so local mock and Ollama workflows run cleanly at `$0.00`.
- **Never start Docker containers** unless the person requested Mode B and port `5432` is available (or `DATABASE_URL` in `.env` already points to their target PostgreSQL database).

## Tell the Person After

Share a concise status report:
1. **Setup mode & substrate**: Confirm where `krusch-coding-harness` was installed and whether it was verified in Mode A (in-process `PGlite` ephemeral mode) or Mode B (persistent PostgreSQL 16 + `:3778` Control Bridge).
2. **Verification results**: Report exact pass counts from `npm run test:unit`, `npm run eval:trajectories`, `npm run typecheck` (and `npm test` / `demo-full-harness-loop.mjs` if Mode B ran).
3. **Configured IDEs**: List every MCP config file updated with the `krusch-harness` entry and remind the person to reload MCP servers or start a fresh agent session so the 7 `krusch_*` tools load.
4. **First-turn test prompt**: Suggest testing in their next session with: `"Use krusch_run and krusch_task_status to verify krusch-harness is connected."`
