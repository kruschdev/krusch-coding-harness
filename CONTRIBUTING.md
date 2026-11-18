# Contributing to `krusch-coding-harness`

Thank you for contributing to `krusch-coding-harness`. I designed this repository around a strict contract: models are interchangeable workers, while task state, staged diffs, sandboxed verification, and crash-recoverable disk writes are enforced deterministically. Every pull request must preserve the invariants below.

---

## 🎯 Repository Scope

`krusch-coding-harness` owns the stateful execution and verification control plane:
- **PostgreSQL / PGlite State Machine (`KruschStateMachine`)**: Row-locked phase transitions (`INIT` -> `PLAN` -> `IMPLEMENT` -> `VERIFY` -> `APPROVAL_GATE` -> `COMMITTED`), single-writer file leases, and budget/loop guards.
- **Content-Addressed Diff Staging & Sandboxed Verification**: Pre-commit SHA-256 blobs (`krusch_blobs`), staged diffs (`krusch_staged_diffs`), and unprivileged Bubblewrap (`bwrap --unshare-net`) or process-jail test execution.
- **Crash-Recoverable 2PC Disk Apply**: Write-ahead preimage journaling (`krusch_apply_journal`) with `fsync`, per-file atomic rename, and cold-worker `SIGKILL` rollback (`recoverInFlightApplies()`).

Capabilities outside that scope belong in sibling repositories:
- **Turn-0 zero-LLM workspace schema & hazard grounding**: [`krusch-grounded-harness`](https://github.com/kruschdev/grounded-harness)
- **Cross-session episodic working memory**: [`krusch-context-mcp`](https://github.com/kruschdev/krusch-context-mcp)
- **Git DAG & AST symbol indexing**: [`krusch-git`](https://github.com/kruschdev/krusch-git)
- **Single-command SQLite/MCP bundle**: [`krusch-stack`](https://github.com/kruschdev/krusch-stack)

---

## 🛠️ Prerequisites & Two Local Verification Paths

- **Node.js `>= 20.0.0`** (`npm ci` installs all runtime and typecheck dependencies, including in-process `@electric-sql/pglite` and `typescript`).
- **Docker Compose & `PostgreSQL 16` (Optional)**: Needed only for Path B persistent multi-connection integration tests and live `SIGKILL` crash-recovery drills.
- **Linux `bwrap` / `Bubblewrap` (Optional)**: Used for `--unshare-net` namespace isolation when present on Linux; falls back cleanly to the scrubbed-environment process jail when absent.

### Path A: Built-In Zero-Docker `PGlite` Path (`<30 seconds`, No API Keys)

Use Path A for fast daily iteration, unit tests, typechecking, and Golden DAG trajectory evaluation without starting Docker or PostgreSQL:

```bash
npm ci

# 1. Run fast unit tests (policy floor, AST indexer, router gate, HITL HMAC gate, cost kill-switch)
npm run test:unit

# 2. Replay all 100 golden trajectories across 10 failure categories (--strict)
npm run eval:trajectories

# 3. Validate TypeScript .d.ts public declarations
npm run typecheck

# 4. Run an end-to-end task in-process against ephemeral PGlite
node bin/krusch.js init --ephemeral
node bin/krusch.js run "Verify arithmetic module fix" --mock --ephemeral --auto-approve
```

### Path B: Docker `PostgreSQL 16` Integration & Crash-Recovery Path

Use Path B whenever you touch SQL migrations (`db/`), connection pooling (`src/brain/`), file leases, `krusch_apply_journal`, or control-plane commands:

```bash
# 1. Start PostgreSQL 16 (defaults to postgresql://postgres:postgres@localhost:5432/krusch)
docker compose up -d

# 2. Apply all SQL schema and row-lock invariant migrations
npm run migrate

# 3. Run the full serial unit + PostgreSQL integration suite (includes real SIGKILL recovery test)
npm test

# 4. Execute the 7-step write-invariant & working-tree drift refusal proof
node bin/krusch.js demo-invariant

# 5. Optional: run the 5-step live stage -> fail -> repair -> SIGKILL rollback -> apply demo
node scripts/demo-full-harness-loop.mjs
```

---

## 🛡️ Non-Negotiable Invariants

1. **2PC Staged Diffs Before Disk Writes**: Model-proposed edits must be written exclusively to `krusch_blobs` and `krusch_staged_diffs` under active single-writer file leases. Physical working-tree files must never be mutated until sandboxed verification succeeds (`exitCode === 0`) and approval is granted. If a target file on disk drifts from its recorded pre-commit SHA-256 hash, `applyDiffBatch()` must refuse the write and fail closed.
2. **`SIGKILL` Write-Ahead Journal Recovery**: Every multi-file apply must persist preimages and apply state into `krusch_apply_journal` with `fsync` before renaming staged files into the working tree. Cold-worker startup (`KruschStateManager.recoverInFlightApplies()`) must deterministically restore preimages and clean up partial writes if a worker dies mid-batch via `SIGKILL`.
3. **Frozen `src/approvals/policy-floor.js` & SHA-256 Benchmark Pin (`INV-PIN-01`)**:
   - `KRUSCH_HARDLINE_FLOOR_RULES` (`FLOOR-FS-ROOT-WIPE`, `FLOOR-DISK-FORMAT`, `FLOOR-PIPE-TO-SHELL`, `FLOOR-CREDENTIAL-EXFIL`, `FLOOR-SQL-DESTRUCTIVE`, `FLOOR-FORK-BOMB`, `FLOOR-PATH-PROTECTED`) and its rule metadata are deep-frozen at import time (`Object.isFrozen`) after ANSI/IFS/hex/octal/base64 command deobfuscation.
   - `src/approvals/policy-floor.js` (along with `src/index.js`, `src/verify/sandbox.js`, and `src/workflow/modular-rsi.js`) is cryptographically SHA-256-pinned in published clean-room benchmark audit manifests. **Do not modify `src/approvals/policy-floor.js` or other SHA-256-pinned files** unless explicitly coordinating a versioned benchmark manifest regeneration. Ship new guards or adapters as additive modules exposed via `package.json` `"exports"` subpaths.
4. **100-Trajectory Golden DAG Gate**: `npm run eval:trajectories` (`node bin/krusch.js eval-trajectories --strict`) must pass `100/100` trajectories across all `10` failure categories. Never delete or weaken existing cases in `test/fixtures/golden-trajectories-100.json`.
5. **Zero Private IPs, Hostnames, or Live Secrets (`INV-STACK-04`)**: Never commit private LAN, 10GbE, or VPN IP addresses, internal machine hostnames, `/home/<user>` or `/mnt/<volume>` paths, or API keys in code, SQL migrations, fixtures, or documentation. Use `localhost` / `127.0.0.1` and `.env.example` placeholders.

---

## 📬 Pull Request Guidelines

- **Type & Contract Hygiene**: Keep `types/*.d.ts` aligned with any public subpath export additions and confirm `npm run typecheck` passes with zero errors.
- **Offline Deterministic Tests**: Ensure unit tests run offline with zero cloud API keys (`--mock` / deterministic fixtures) and clean up temporary directories on exit.
- **Documentation Style (`INV-SOLO-VOICE-01`)**: Write documentation in singular first-person (`"I"`, `"my"`, `"me"`) or second-person (`"you"`, `"your"`), with zero plural first-person pronouns and zero em-dash characters.
- **Pre-PR Checklist**: Verify `npm run test:unit`, `npm run eval:trajectories`, and `npm run typecheck` (plus `npm test` and `node bin/krusch.js demo-invariant` when touching database or apply-journal paths) exit `0`.
