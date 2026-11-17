/**
 * @module workflow/wave-planner
 * @description Disjoint Parallel Subagent File-Lease & Execution-Wave Solver for `krusch-coding-harness`.
 * Mirrors `@krusch/toolkit/parallel-planner` while keeping `krusch-coding-harness` 100% standalone (`INV-LEGO-28A`).
 */

import path from 'node:path';

export const HARNESS_CHOKE_POINT_FILES = Object.freeze([
  'server.js',
  'src/server.js',
  'app.js',
  'src/app.js',
  'index.js',
  'src/index.js',
  'main.js',
  'src/main.js',
  'tools.js',
  'src/tools.js',
  'App.jsx',
  'src/App.jsx',
  'client/src/App.jsx',
  'App.tsx',
  'src/App.tsx',
  'client/src/App.tsx',
  'package.json'
]);

function normalizeRel(rawPath) {
  const clean = String(rawPath ?? '')
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/+|\/+)+/, '')
    .trim();
  if (!clean || clean === '.' || clean.includes('\0')) return '';
  const norm = path.posix.normalize(clean);
  if (!norm || norm === '.' || norm === '..' || norm.startsWith('../')) return '';
  return norm;
}

function isChoke(relPath, chokeSet) {
  if (!relPath) return false;
  if (chokeSet.has(relPath)) return true;
  const base = path.posix.basename(relPath);
  return (base === 'package.json' || base === 'App.jsx' || base === 'App.tsx') && chokeSet.has(base);
}

/**
 * Partition candidate subagent tasks / Work Orders into conflict-free parallel execution waves
 * based on 2-hop inbound AST/import blast-radius cones while reserving orchestrator choke points.
 *
 * @param {object} [params={}]
 * @param {Array<{ id?: string, workOrderId?: string, title?: string, targetFiles?: string[], files?: string[] }>} [params.tasks=[]]
 * @param {Array<{ from?: string, to?: string, source_path?: string, target_path?: string }>} [params.edges=[]]
 * @param {Iterable<string>} [params.chokePoints=HARNESS_CHOKE_POINT_FILES]
 */
export function planHarnessDisjointWaves({
  tasks = [],
  edges = [],
  chokePoints = HARNESS_CHOKE_POINT_FILES
} = {}) {
  const chokeSet = new Set();
  for (const cp of chokePoints) {
    const norm = normalizeRel(cp);
    if (norm) chokeSet.add(norm);
  }

  const inboundCallers = new Map();
  for (const edge of edges) {
    if (!edge || typeof edge !== 'object') continue;
    const from = normalizeRel(edge.from ?? edge.source_path ?? edge.sourcePath);
    const to = normalizeRel(edge.to ?? edge.target_path ?? edge.targetPath);
    if (!from || !to || from === to) continue;
    if (!inboundCallers.has(to)) inboundCallers.set(to, new Set());
    inboundCallers.get(to).add(from);
  }

  const reservedOrchestratorFiles = new Set();
  const leases = tasks.map((t, idx) => {
    const taskId = String(t?.id ?? t?.workOrderId ?? `TASK-${idx + 1}`).trim() || `TASK-${idx + 1}`;
    const rawTargets = Array.isArray(t?.targetFiles) ? t.targetFiles : Array.isArray(t?.files) ? t.files : [];
    const targetFiles = [...new Set(rawTargets.map(normalizeRel).filter(Boolean))];
    const seenTargets = new Set(targetFiles);
    const cone = new Set(targetFiles);
    const hop1 = new Set();
    const hop2 = new Set();
    const touchedChoke = new Set();

    for (const tf of targetFiles) {
      if (isChoke(tf, chokeSet)) {
        touchedChoke.add(tf);
        reservedOrchestratorFiles.add(tf);
      }
      for (const c1 of inboundCallers.get(tf) || []) {
        if (isChoke(c1, chokeSet)) {
          touchedChoke.add(c1);
          reservedOrchestratorFiles.add(c1);
          continue;
        }
        cone.add(c1);
        if (!seenTargets.has(c1)) hop1.add(c1);
        for (const c2 of inboundCallers.get(c1) || []) {
          if (isChoke(c2, chokeSet)) {
            touchedChoke.add(c2);
            reservedOrchestratorFiles.add(c2);
          } else if (c2 !== tf && !seenTargets.has(c2) && !hop1.has(c2)) {
            hop2.add(c2);
            cone.add(c2);
          }
        }
      }
    }

    for (const cp of touchedChoke) {
      if (!seenTargets.has(cp)) cone.delete(cp);
    }

    return {
      taskId,
      title: String(t?.title ?? taskId),
      targetFiles,
      hop1Dependents: [...hop1].sort(),
      hop2Dependents: [...hop2].sort(),
      leaseCone: [...cone].sort(),
      reservedChokePoints: [...touchedChoke].sort(),
      wave: 1
    };
  });

  const buckets = [];
  for (const lease of leases) {
    let waveIdx = buckets.findIndex((b) => !lease.leaseCone.some((f) => b.files.has(f)));
    if (waveIdx === -1) {
      waveIdx = buckets.length;
      buckets.push({ wave: waveIdx + 1, taskIds: [], files: new Set() });
    }
    lease.wave = waveIdx + 1;
    buckets[waveIdx].taskIds.push(lease.taskId);
    for (const f of lease.leaseCone) buckets[waveIdx].files.add(f);
  }

  const collisions = [];
  for (let i = 0; i < leases.length; i++) {
    const setA = new Set(leases[i].leaseCone);
    for (let j = i + 1; j < leases.length; j++) {
      const sharedFiles = leases[j].leaseCone.filter((f) => setA.has(f));
      if (sharedFiles.length > 0) {
        collisions.push({ tasks: [leases[i].taskId, leases[j].taskId], sharedFiles });
      }
    }
  }

  return {
    waves: buckets.map((b) => ({
      wave: b.wave,
      taskIds: b.taskIds,
      parallelizable: b.taskIds.length > 1,
      leasedFileCount: b.files.size
    })),
    leases,
    collisions,
    reservedOrchestratorFiles: [...reservedOrchestratorFiles].sort()
  };
}
