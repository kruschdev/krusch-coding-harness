/**
 * Krusch Software Factory Control Room UI
 * Served at GET / and GET /factory by startBridgeServer (127.0.0.1:3778)
 */
export function renderFactoryControlRoomHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Krusch Software Factory // 3-Tier Autonomous Control Room</title>
  <style>
    :root {
      --bg: #05060b;
      --card: rgba(13, 17, 28, 0.92);
      --border: rgba(148, 163, 184, 0.16);
      --cyan: #00e5ff;
      --violet: #a855f7;
      --emerald: #10b981;
      --amber: #f59e0b;
      --rose: #f43f5e;
      --text: #f8fafc;
      --muted: #94a3b8;
      --mono: 'Fira Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
      --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      min-height: 100vh;
      line-height: 1.5;
      background-image:
        radial-gradient(circle at 15% 10%, rgba(0, 229, 255, 0.08), transparent 35%),
        radial-gradient(circle at 85% 20%, rgba(168, 85, 247, 0.08), transparent 35%),
        linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 32px 32px, 32px 32px;
    }
    header {
      border-bottom: 1px solid var(--border);
      background: rgba(5, 6, 11, 0.88);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 20;
      padding: 14px 28px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 800;
      letter-spacing: 0.08em;
      font-size: 15px;
    }
    .brand strong { color: var(--cyan); }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: var(--mono);
      font-size: 12px;
      padding: 5px 12px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.35);
      color: #34d399;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 8px var(--emerald);
    }
    main {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px 28px 64px;
    }
    .telemetry-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 18px;
    }
    .metric-val {
      font-family: var(--mono);
      font-size: 20px;
      font-weight: 700;
      color: var(--cyan);
    }
    .metric-lbl {
      font-size: 12px;
      color: var(--muted);
      margin-top: 4px;
    }
    .stations-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 20px;
    }
    @media (max-width: 1024px) {
      .stations-grid { grid-template-columns: 1fr; }
    }
    .station {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .station-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 10px;
    }
    .station-eyebrow {
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--cyan);
    }
    .station-title {
      font-size: 16px;
      font-weight: 700;
      margin-top: 2px;
    }
    .badge {
      font-family: var(--mono);
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 6px;
      background: rgba(0, 229, 255, 0.12);
      border: 1px solid rgba(0, 229, 255, 0.3);
      color: var(--cyan);
    }
    .badge.violet {
      background: rgba(168, 85, 247, 0.12);
      border-color: rgba(168, 85, 247, 0.35);
      color: #c084fc;
    }
    .badge.emerald {
      background: rgba(16, 185, 129, 0.12);
      border-color: rgba(16, 185, 129, 0.35);
      color: #34d399;
    }
    .row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    input, textarea {
      width: 100%;
      background: rgba(5, 6, 11, 0.85);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-family: var(--mono);
      font-size: 12.5px;
      padding: 9px 12px;
      outline: none;
    }
    input:focus, textarea:focus {
      border-color: var(--cyan);
    }
    button {
      background: linear-gradient(135deg, rgba(0, 229, 255, 0.2), rgba(0, 229, 255, 0.08));
      border: 1px solid rgba(0, 229, 255, 0.45);
      color: var(--cyan);
      font-family: var(--sans);
      font-weight: 600;
      font-size: 12.5px;
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    button:hover {
      background: rgba(0, 229, 255, 0.28);
      color: #fff;
    }
    button.secondary {
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--border);
      color: var(--muted);
    }
    button.secondary:hover {
      color: var(--text);
      border-color: rgba(255, 255, 255, 0.3);
    }
    button.emerald-btn {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(16, 185, 129, 0.08));
      border-color: rgba(16, 185, 129, 0.5);
      color: #34d399;
    }
    .output-box {
      background: rgba(3, 4, 8, 0.92);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-family: var(--mono);
      font-size: 12px;
      color: #cbd5e1;
      max-height: 270px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .pill-btn {
      font-size: 11px;
      padding: 4px 9px;
      border-radius: 999px;
      font-family: var(--mono);
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <svg viewBox="0 -2 132 218" width="16" height="26" aria-label="Krusch 13-point lightning bolt">
        <defs>
          <linearGradient id="boltGrad-factory" x1="78%" y1="4%" x2="18%" y2="96%"><stop offset="0%" stop-color="#6ff1fe"/><stop offset="24%" stop-color="#37e1ff"/><stop offset="48%" stop-color="#7be8ff"/><stop offset="72%" stop-color="#8b6eff"/><stop offset="90%" stop-color="#9d4edd"/><stop offset="100%" stop-color="#d946ef"/></linearGradient>
          <linearGradient id="boltRim-factory" x1="80%" y1="0%" x2="15%" y2="100%"><stop offset="0%" stop-color="#bef8ff"/><stop offset="45%" stop-color="#ffffff"/><stop offset="80%" stop-color="#f5d0fe"/><stop offset="100%" stop-color="#fae8ff"/></linearGradient>
        </defs>
        <polygon points="121,2 79,25 93,28 48,50 78,53 19,89 58,85 5,128 44,124 5,158 34,155 4,212 47,191 35,186 70,171 52,168 105,139 66,140 123,103 74,105 128,69 86,69 126,35 102,36" fill="url(#boltGrad-factory) #37e1ff" stroke="url(#boltRim-factory)" stroke-width="2.6" stroke-linejoin="round" />
      </svg>
      <span>KRUSCH <strong>SOFTWARE FACTORY</strong> // 3-TIER CONTROL ROOM</span>
    </div>
    <div class="status-pill" id="bridge-status">
      <span class="dot"></span>
      <span>ACID Bridge Active · 3-Tier MCP Ready</span>
    </div>
  </header>

  <main>
    <div class="telemetry-strip">
      <div class="metric-card">
        <div class="metric-val">&lt;15µs / L1+L2</div>
        <div class="metric-lbl">Syntactic CPU Gate &amp; Neural Centroid Cascade</div>
      </div>
      <div class="metric-card">
        <div class="metric-val">5 Verbs · ~350 tok</div>
        <div class="metric-lbl">Tier 1 Memory (INV-12 SHA-256 Span Provenance)</div>
      </div>
      <div class="metric-card">
        <div class="metric-val" id="ast-metric-val">AST Call Graph</div>
        <div class="metric-lbl">Tier 2 Zero-DB Caller/Callee Blast Radius</div>
      </div>
      <div class="metric-card">
        <div class="metric-val">2PC Write Journal</div>
        <div class="metric-lbl">Tier 3 Staged Diffs, Sandbox Tests &amp; Drift Refusal</div>
      </div>
    </div>

    <div class="stations-grid">
      <!-- STATION 1: Tier 1 Memory & Pre-Commit Invariant Gate -->
      <section class="station">
        <div class="station-header">
          <div>
            <div class="station-eyebrow">STATION 01 · TIER 1 WORKING MEMORY (krusch-context-mcp)</div>
            <div class="station-title">Governed Invariants, Temporal Lineage &amp; Pre-Commit Nudge</div>
          </div>
          <span class="badge">5 Canonical Verbs</span>
        </div>
        <div class="row">
          <button onclick="hydrateMemoryState()">Hydrate State (retrieve)</button>
          <button class="secondary" onclick="auditDiffWithNudge()">Audit Staged Diff (nudge)</button>
        </div>
        <textarea id="nudge-input" rows="3" placeholder="Paste code diff or proposed change to audit against active project invariants...">export async function applyRawSql(userInput) {\n  return db.exec("SELECT * FROM users WHERE name = '" + userInput + "'");\n}</textarea>
        <div class="output-box" id="memory-output">Click "Hydrate State" or "Audit Staged Diff" to inspect Tier 1 Working Memory...</div>
      </section>

      <!-- STATION 2: Tier 2 AST & Blast Radius Graph -->
      <section class="station">
        <div class="station-header">
          <div>
            <div class="station-eyebrow">STATION 02 · TIER 2 STRUCTURAL GRAPH (krusch-git / AST)</div>
            <div class="station-title">Legacy Codebase AST &amp; Caller/Callee Blast Radius</div>
          </div>
          <span class="badge violet">Zero-DB Fast AST</span>
        </div>
        <div class="row" style="flex-wrap: nowrap;">
          <input id="ast-symbol" value="startBridgeServer" placeholder="Symbol name (e.g. startBridgeServer, applyDiffBatch)" />
          <button onclick="runAstBlastRadius()">Trace Blast Radius</button>
        </div>
        <div class="row">
          <button class="secondary pill-btn" onclick="setAstSymbol('startBridgeServer')">startBridgeServer</button>
          <button class="secondary pill-btn" onclick="setAstSymbol('applyDiffBatch')">applyDiffBatch</button>
          <button class="secondary pill-btn" onclick="setAstSymbol('routePipeline')">routePipeline</button>
          <button class="secondary pill-btn" onclick="setAstSymbol('runInvariantDemo')">runInvariantDemo</button>
        </div>
        <div class="output-box" id="ast-output">Tracing AST symbol graph...</div>
      </section>

      <!-- STATION 3: L1/L2 Cascade Router & Zero-Context-Loss Model Switch -->
      <section class="station">
        <div class="station-header">
          <div>
            <div class="station-eyebrow">STATION 03 · COMPUTE ROUTING (krusch-cascade-router)</div>
            <div class="station-title">Microsecond L1/L2 Ticket Router &amp; Prefix Parity Proof</div>
          </div>
          <span class="badge">74.44% RouterArena (0.7263)</span>
        </div>
        <div class="row" style="flex-wrap: nowrap;">
          <input id="route-prompt" value="Modernize legacy authentication module and verify all inbound callers pass unit tests" placeholder="Enter ticket description or SQL/code snippet..." />
          <button onclick="runRouteTicket()">Route Ticket</button>
        </div>
        <div class="row">
          <button class="secondary pill-btn" onclick="setRoutePrompt('SELECT id, email FROM users WHERE active = true;')">Test L1 SQL Fast-Path (&lt;15µs)</button>
          <button class="secondary pill-btn" onclick="runVerifyModelSwitch()">Verify Cross-Provider SHA-256 Prefix Parity</button>
        </div>
        <div class="output-box" id="route-output">Ready to route ticket...</div>
      </section>

      <!-- STATION 4: Tier 3 ACID 2PC Execution Gate & 7-Step Invariant Proof -->
      <section class="station">
        <div class="station-header">
          <div>
            <div class="station-eyebrow">STATION 04 · TIER 3 STAGED EXECUTION (krusch-harness)</div>
            <div class="station-title">Two-Phase Commit (2PC) Sandbox Gate &amp; Drift Refusal</div>
          </div>
          <span class="badge emerald">ACID 2PC Gate</span>
        </div>
        <div class="row">
          <button class="emerald-btn" onclick="runSevenStepProof()">⚡ Execute 7-Step Write Invariant &amp; Drift Refusal Proof</button>
          <button class="secondary" onclick="runMockTicketTask()">Stage Ticket-to-PR Task (--mock)</button>
        </div>
        <div class="output-box" id="harness-output">Click "Execute 7-Step Write Invariant &amp; Drift Refusal Proof" to verify sandbox staging, failing test block, 2PC apply, and out-of-band developer edit protection...</div>
      </section>
    </div>
  </main>

  <script>
    async function hydrateMemoryState() {
      const box = document.getElementById('memory-output');
      box.textContent = 'Hydrating Tier 1 state from krusch-context-mcp...';
      try {
        const res = await fetch('/api/state?project=krusch');
        const data = await res.json();
        box.textContent = data.stateMarkdown || JSON.stringify(data, null, 2);
      } catch (err) {
        box.textContent = 'Error: ' + err.message;
      }
    }

    async function auditDiffWithNudge() {
      const box = document.getElementById('memory-output');
      const code = document.getElementById('nudge-input').value;
      box.textContent = 'Running pre_commit invariant audit via krusch_context_nudge...';
      try {
        const res = await fetch('/api/nudge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger: 'pre_commit', code })
        });
        const data = await res.json();
        box.textContent = data.result || JSON.stringify(data, null, 2);
      } catch (err) {
        box.textContent = 'Error: ' + err.message;
      }
    }

    function setAstSymbol(sym) {
      document.getElementById('ast-symbol').value = sym;
      runAstBlastRadius();
    }

    async function runAstBlastRadius() {
      const sym = document.getElementById('ast-symbol').value.trim();
      const box = document.getElementById('ast-output');
      box.textContent = 'Scanning repository AST & caller/callee edges...';
      try {
        const res = await fetch('/api/ast/graph?symbol=' + encodeURIComponent(sym));
        const data = await res.json();
        document.getElementById('ast-metric-val').textContent =
          data.totalSymbols + ' Syms · ' + data.durationMs + 'ms';
        const lines = [];
        lines.push('📁 Repo: ' + data.projectPath + ' (' + data.filesScanned + ' files, ' + data.totalSymbols + ' AST symbols in ' + data.durationMs + 'ms)');
        if (data.targetSymbol) {
          lines.push('\\n🎯 Target Symbol: [' + data.targetSymbol.symbol_type + '] ' + data.targetSymbol.signature);
          lines.push('   Location: ' + data.targetSymbol.file_path + ':' + data.targetSymbol.start_line);
        }
        lines.push('\\n⬅️ Inbound Callers / Dependents (' + (data.inboundCallers?.length || 0) + '):');
        for (const c of (data.inboundCallers || [])) {
          lines.push('   • ' + c.file_path + ':' + c.line + ' (in ' + c.caller_symbol + ') -> ' + c.snippet);
        }
        lines.push('\\n➡️ Outbound Callees (' + (data.outboundCallees?.length || 0) + '):');
        for (const out of (data.outboundCallees || [])) {
          lines.push('   • [' + out.symbol_type + '] ' + out.symbol_name + ' (' + out.file_path + ':' + out.line + ')');
        }
        box.textContent = lines.join('\\n');
      } catch (err) {
        box.textContent = 'Error: ' + err.message;
      }
    }

    function setRoutePrompt(p) {
      document.getElementById('route-prompt').value = p;
      runRouteTicket();
    }

    async function runRouteTicket() {
      const prompt = document.getElementById('route-prompt').value;
      const box = document.getElementById('route-output');
      try {
        const res = await fetch('/api/route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt })
        });
        const data = await res.json();
        box.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        box.textContent = 'Error: ' + err.message;
      }
    }

    async function runVerifyModelSwitch() {
      const box = document.getElementById('route-output');
      box.textContent = 'Verifying SHA-256 system prefix parity across Claude, Gemini, and Ollama...';
      try {
        const res = await fetch('/api/harness/verify-models', { method: 'POST' });
        const data = await res.json();
        box.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        box.textContent = 'Error: ' + err.message;
      }
    }

    async function runSevenStepProof() {
      const box = document.getElementById('harness-output');
      box.textContent = 'Running 7-Step Write Invariant & Drift Refusal Proof...';
      try {
        const res = await fetch('/api/harness/demo-invariant', { method: 'POST' });
        const data = await res.json();
        if (data.steps) {
          box.textContent = data.steps.join('\\n') + '\\n\\nCompleted in ' + data.durationMs + 'ms (status: ' + (data.ok ? 'VERIFIED' : 'FAILED') + ')';
        } else {
          box.textContent = JSON.stringify(data, null, 2);
        }
      } catch (err) {
        box.textContent = 'Error: ' + err.message;
      }
    }

    async function runMockTicketTask() {
      const box = document.getElementById('harness-output');
      const goal = document.getElementById('route-prompt').value || 'Modernize legacy module with 2PC verification';
      box.textContent = 'Enqueuing ticket into ACID State Machine...';
      try {
        const res = await fetch('/api/harness/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal, useMock: true, autoApprove: false })
        });
        const data = await res.json();
        await new Promise(r => setTimeout(r, 350));
        const statusRes = await fetch('/api/harness/status?taskId=' + encodeURIComponent(data.taskId));
        const statusData = await statusRes.json();
        box.textContent = JSON.stringify({ launched: data, taskState: statusData }, null, 2);
      } catch (err) {
        box.textContent = 'Error: ' + err.message;
      }
    }

    // Initial load
    runAstBlastRadius();
    runRouteTicket();
  </script>
</body>
</html>`;
}
