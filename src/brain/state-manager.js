import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { query, withTransaction } from './pool.js';
import { KruschTestRunner } from '../verify/test-runner.js';

const BENIGN_DIR_FSYNC_CODES = new Set(['EINVAL', 'EBADF', 'EISDIR', 'ENOTSUP', 'EPERM']);

/**
 * Flush parent directory metadata after atomic rename or unlink so directory entries
 * survive power loss. Tolerates filesystems/OSes that reject directory fsync while
 * propagating genuine I/O or resource errors (EIO, ENOSPC, ENOMEM).
 */
export function fsyncDirectory(dirPath, fsOps = fs) {
  let fd;
  try {
    fd = fsOps.openSync(dirPath, 'r');
  } catch (openErr) {
    if (openErr && BENIGN_DIR_FSYNC_CODES.has(openErr.code)) {
      return;
    }
    throw openErr;
  }
  try {
    fsOps.fsyncSync(fd);
  } catch (fsyncErr) {
    if (fsyncErr && BENIGN_DIR_FSYNC_CODES.has(fsyncErr.code)) {
      return;
    }
    throw fsyncErr;
  } finally {
    try {
      fsOps.closeSync(fd);
    } catch (closeErr) {
      if (closeErr && closeErr.code !== 'EBADF') {
        console.warn(`[KruschStateManager] Failed to close directory fd for ${dirPath}: ${closeErr.message}`);
      }
    }
  }
}

/**
 * Read a UTF-8 file directly without `fs.existsSync` so transient OS errors
 * (EIO, EACCES, ENOMEM, EMFILE) propagate rather than masquerading as missing files.
 */
function readTextIfExists(filePath, fsOps = fs) {
  try {
    const content = fsOps.readFileSync(filePath, 'utf-8');
    return { exists: true, content };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { exists: false, content: null };
    }
    throw err;
  }
}

/**
 * Unlink a file if present, ignoring strictly ENOENT and propagating EACCES/EIO/EBUSY.
 * Returns true when an existing directory entry was unlinked, false when already absent.
 */
function unlinkIfExists(filePath, fsOps = fs) {
  try {
    fsOps.unlinkSync(filePath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Write a complete UTF-8 buffer to fd, looping across partial POSIX write(2) calls
 * on near-ENOSPC filesystems so truncated blocks are never fsynced/renamed.
 */
function writeAllSync(fd, content, tempPath, fsOps = fs) {
  const payload = Buffer.isBuffer(content)
    ? content
    : content instanceof Uint8Array
      ? Buffer.from(content)
      : Buffer.from(String(content ?? ''), 'utf8');

  if (payload.length === 0) {
    fsOps.writeSync(fd, payload, 0, 0);
    return;
  }

  let offset = 0;
  while (offset < payload.length) {
    const written = fsOps.writeSync(fd, payload, offset, payload.length - offset);
    if (typeof written !== 'number') {
      return;
    }
    if (written <= 0) {
      const shortWriteErr = new Error(`Short write (0 bytes) to temporary file: ${tempPath}`);
      shortWriteErr.code = 'EIO';
      throw shortWriteErr;
    }
    offset += written;
  }
}

/**
 * Clean up orphaned temporary files matching .${basename}.krusch-*-tmp-*
 * Propagates directory I/O errors (EIO, EACCES) when throwOnIoError is true.
 */
export function cleanOrphanedTempFiles(fullPath, fsOps = fs, { throwOnIoError = false } = {}) {
  const targetDir = path.dirname(fullPath);
  const baseName = path.basename(fullPath);
  try {
    const entries = fsOps.readdirSync(targetDir);
    const prefix = `.${baseName}.krusch-`;
    for (const entry of entries) {
      const file = typeof entry === 'string' ? entry : entry?.name;
      if (file && file.startsWith(prefix) && file.includes('-tmp-')) {
        try {
          fsOps.unlinkSync(path.join(targetDir, file));
        } catch (err) {
          if (err && err.code !== 'ENOENT') {
            if (throwOnIoError) throw err;
            console.warn(`[KruschStateManager] Failed to unlink orphaned temp file ${file}: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      if (throwOnIoError) throw err;
      console.warn(`[KruschStateManager] Failed to scan directory ${targetDir} for orphaned temp files: ${err.message}`);
    }
  }
}

/**
 * Write a file atomically using a temporary sibling file, full-buffer write loop, fsync,
 * atomic POSIX rename, and parent directory fsync. Never leaks file descriptors or partial temp files.
 */
export function atomicWriteFile(targetPath, content, fsOps = fs) {
  const targetDir = path.dirname(targetPath);
  fsOps.mkdirSync(targetDir, { recursive: true });
  const randSuffix = crypto.randomBytes(4).toString('hex');
  const tempPath = path.resolve(targetDir, `.${path.basename(targetPath)}.krusch-atomic-tmp-${Date.now()}-${randSuffix}`);
  const fd = fsOps.openSync(tempPath, 'w');
  try {
    let writeErr = null;
    try {
      writeAllSync(fd, content, tempPath, fsOps);
      fsOps.fsyncSync(fd);
    } catch (err) {
      writeErr = err;
      throw err;
    } finally {
      try {
        fsOps.closeSync(fd);
      } catch (closeErr) {
        if (!writeErr) {
          throw closeErr;
        }
        console.warn(`[KruschStateManager] Failed to close fd for ${tempPath} after write/fsync error: ${closeErr.message}`);
      }
    }
    fsOps.renameSync(tempPath, targetPath);
  } catch (err) {
    try {
      fsOps.unlinkSync(tempPath);
    } catch (unlinkErr) {
      if (unlinkErr && unlinkErr.code !== 'ENOENT') {
        console.warn(`[KruschStateManager] Failed to unlink partial atomic temp file ${tempPath}: ${unlinkErr.message}`);
      }
    }
    throw err;
  }
  fsyncDirectory(targetDir, fsOps);
}

/**
 * Canonicalize project_path and file_path to guarantee consistent lease keys
 * regardless of path formatting (e.g. ./src/a.js vs src/a.js vs /abs/repo/src/a.js vs case-folding/symlinks).
 */
export function canonicalizePaths(projectPath, filePath) {
  let resolvedProject = projectPath ? path.resolve(projectPath) : process.cwd();
  if (fs.existsSync(resolvedProject)) {
    try {
      resolvedProject = fs.realpathSync.native(resolvedProject);
    } catch (_) {
      resolvedProject = fs.realpathSync(resolvedProject);
    }
  }

  let absoluteFilePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(resolvedProject, filePath);

  if (fs.existsSync(absoluteFilePath)) {
    try {
      absoluteFilePath = fs.realpathSync.native(absoluteFilePath);
    } catch (_) {
      absoluteFilePath = fs.realpathSync(absoluteFilePath);
    }
  } else {
    const parentDir = path.dirname(absoluteFilePath);
    if (fs.existsSync(parentDir)) {
      try {
        const canonicalParent = fs.realpathSync.native(parentDir);
        absoluteFilePath = path.join(canonicalParent, path.basename(absoluteFilePath));
      } catch (realpathErr) {
        if (realpathErr && realpathErr.code !== 'ENOENT') {
          try {
            const fallbackParent = fs.realpathSync(parentDir);
            absoluteFilePath = path.join(fallbackParent, path.basename(absoluteFilePath));
          } catch (fallbackErr) {
            if (fallbackErr && fallbackErr.code !== 'ENOENT') {
              console.warn(`[KruschStateManager] Failed to canonicalize parent directory ${parentDir}: ${fallbackErr.message}`);
            }
          }
        }
      }
    }
  }

  let relativeFilePath = path.relative(resolvedProject, absoluteFilePath);
  if (relativeFilePath.startsWith('..') || path.isAbsolute(relativeFilePath)) {
    throw new Error(`Invalid path: path '${filePath}' traverses outside project root '${resolvedProject}'`);
  }

  let normalizedFilePath = relativeFilePath.split(path.sep).join('/');
  // Strip leading ./ if present
  normalizedFilePath = normalizedFilePath.replace(/^(\.\/)+/, '');

  const canonicalProjectPath = resolvedProject.split(path.sep).join('/');
  return { projectPath: canonicalProjectPath, filePath: normalizedFilePath };
}

function parseJournalFiles(rawFiles) {
  if (Array.isArray(rawFiles)) return rawFiles;
  if (typeof rawFiles === 'string' && rawFiles.trim()) {
    try {
      const parsed = JSON.parse(rawFiles);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export class KruschStateManager {
  /**
   * Create a new task in PostgreSQL with resolved verification_command.
   */
  static async createTask({ id, goal, projectPath, phase = 'INIT', currentModel = null, metadata = {}, verificationCommand = null }) {
    const taskId = id || `task_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const resolvedVerificationCmd = verificationCommand || KruschTestRunner.detectTestCommand(projectPath);
    const sql = `
      INSERT INTO krusch_tasks (id, goal, project_path, phase, current_model, metadata, verification_command, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, goal, projectPath, phase, currentModel, JSON.stringify(metadata), resolvedVerificationCmd]);
    return res.rows[0];
  }

  /**
   * Update task state (e.g. phase, active model, metadata).
   */
  static async updateTask(taskId, { phase, currentModel, metadata }) {
    const updates = [];
    const values = [taskId];
    let paramIndex = 2;

    if (phase !== undefined) {
      updates.push(`phase = $${paramIndex++}`);
      values.push(phase);
    }
    if (currentModel !== undefined) {
      updates.push(`current_model = $${paramIndex++}`);
      values.push(currentModel);
    }
    if (metadata !== undefined) {
      updates.push(`metadata = metadata || $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(metadata));
    }
    updates.push(`updated_at = NOW()`);

    const sql = `
      UPDATE krusch_tasks
      SET ${updates.join(', ')}
      WHERE id = $1
      RETURNING *;
    `;
    return await withTransaction(async (client) => {
      const res = await client.query(sql, values);
      if (phase === 'COMMITTED') {
        await client.query(
          `UPDATE krusch_staged_diffs SET status = 'COMMITTED' WHERE task_id = $1 AND status = 'APPLIED'`,
          [taskId]
        );
      } else if (phase === 'ABORTED') {
        await client.query(
          `UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE task_id = $1 AND status IN ('PENDING', 'APPLYING')`,
          [taskId]
        );
      }
      return res.rows[0];
    });
  }

  /**
   * Fetch full task with turns, events, and staged diffs.
   */
  static async getTask(taskId) {
    const taskRes = await query('SELECT * FROM krusch_tasks WHERE id = $1', [taskId]);
    if (taskRes.rows.length === 0) return null;

    const task = taskRes.rows[0];
    const turnsRes = await query('SELECT * FROM krusch_turns WHERE task_id = $1 ORDER BY turn_number ASC', [taskId]);
    const diffsRes = await query('SELECT * FROM krusch_staged_diffs WHERE task_id = $1 ORDER BY id ASC', [taskId]);
    const approvalsRes = await query('SELECT * FROM krusch_approvals WHERE task_id = $1 ORDER BY id ASC', [taskId]);
    const verifRes = await query('SELECT * FROM krusch_verification_runs WHERE task_id = $1 ORDER BY id DESC, created_at DESC', [taskId]);

    return {
      ...task,
      turns: turnsRes.rows,
      stagedDiffs: diffsRes.rows,
      approvals: approvalsRes.rows,
      verifications: verifRes.rows,
    };
  }

  /**
   * Record an execution turn (model interaction).
   */
  static async recordTurn(taskId, { turnNumber, modelId, inputMessages, outputText, thoughtTrace, tokenUsage, latencyMs, routingStage }) {
    const sql = `
      INSERT INTO krusch_turns (
        task_id, turn_number, model_id, input_messages, output_text, thought_trace, token_usage, latency_ms, routing_stage, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [
      taskId,
      turnNumber,
      modelId,
      JSON.stringify(inputMessages || []),
      outputText || null,
      thoughtTrace || null,
      JSON.stringify(tokenUsage || {}),
      latencyMs || null,
      routingStage || 'DIRECT'
    ]);
    return res.rows[0];
  }

  /**
   * Record a lifecycle or tool event.
   */
  static async recordEvent(taskId, turnId, eventType, payload) {
    const sql = `
      INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, turnId || null, eventType, JSON.stringify(payload || {})]);
    return res.rows[0];
  }

  /**
   * Stage a file diff into PostgreSQL before disk mutation.
   * Enforces single-writer file lease per (project_path, file_path) with lease TTL.
   */
  static async stageDiff(taskId, { filePath, originalContent, stagedContent, diffPatch, projectPath = null }) {
    const hash = crypto.createHash('sha256').update(stagedContent).digest('hex');
    const originalHash = (originalContent !== null && originalContent !== undefined && originalContent !== '')
      ? crypto.createHash('sha256').update(originalContent).digest('hex')
      : null;

    let targetProjectPath = projectPath;
    if (!targetProjectPath) {
      const taskRes = await query('SELECT project_path FROM krusch_tasks WHERE id = $1', [taskId]);
      targetProjectPath = taskRes.rows[0]?.project_path || process.cwd();
    }

    // Canonicalize paths to ensure single-writer lease consistency
    const canonical = canonicalizePaths(targetProjectPath, filePath);
    targetProjectPath = canonical.projectPath;
    const canonicalFilePath = canonical.filePath;

    const ttlMinutes = parseInt(process.env.KRUSCH_LEASE_TTL_MINUTES || '15', 10);
    const ttlIntervalSql = `${ttlMinutes} minutes`;

    // Check for existing active diff lease on this file in this project (PENDING, APPLYING, or APPLIED)
    const existingRes = await query(
      `SELECT id, task_id, status, lease_expires_at FROM krusch_staged_diffs WHERE project_path = $1 AND file_path = $2 AND status IN ('PENDING', 'APPLYING', 'APPLIED')`,
      [targetProjectPath, canonicalFilePath]
    );

    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];
      const isExpired = existing.lease_expires_at && new Date(existing.lease_expires_at) < new Date();

      if (existing.task_id === taskId) {
        if (existing.status === 'APPLIED') {
          throw new Error(
            `CONCURRENCY_LEASE_CONFLICT: File '${canonicalFilePath}' has already been APPLIED by task '${taskId}'. Staged modifications cannot overwrite applied state without explicit rollback or abort.`
          );
        }
        // Same task updating its staged diff, refresh lease TTL
        const updateSql = `
          UPDATE krusch_staged_diffs
          SET original_content = $1, staged_content = $2, diff_patch = $3, sha256_hash = $4, original_sha256 = $5,
              lease_expires_at = NOW() + $6::interval, created_at = NOW()
          WHERE id = $7
          RETURNING *;
        `;
        const res = await query(updateSql, [originalContent, stagedContent, diffPatch, hash, originalHash, ttlIntervalSql, existing.id]);
        return res.rows[0];
      } else if (isExpired) {
        // Lease has expired; break/prune the stale lease and claim for new task
        await query(`UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE id = $1`, [existing.id]);
        await KruschStateManager.recordEvent(existing.task_id, null, 'lease_expired', {
          filePath: canonicalFilePath,
          previousTaskId: existing.task_id,
          claimedByTaskId: taskId,
          reason: `Lease expired after ${ttlMinutes} minutes.`
        });
      } else {
        // Different task holds an active, unexpired lease
        await KruschStateManager.recordEvent(taskId, null, 'lease_conflict', {
          filePath: canonicalFilePath,
          conflictTaskId: existing.task_id,
          status: existing.status,
          expiresAt: existing.lease_expires_at
        });
        throw new Error(
          `CONCURRENCY_LEASE_CONFLICT: File '${canonicalFilePath}' is currently held under ${existing.status} lease by task '${existing.task_id}'. Cannot stage concurrent modification.`
        );
      }
    }

    const sql = `
      INSERT INTO krusch_staged_diffs (
        task_id, project_path, file_path, original_content, staged_content, diff_patch, status, sha256_hash, original_sha256, lease_expires_at, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, NOW() + $9::interval, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, targetProjectPath, canonicalFilePath, originalContent, stagedContent, diffPatch, hash, originalHash, ttlIntervalSql]);

    // Store blobs into krusch_blobs for content-addressing & deduplication
    try {
      await query(
        `INSERT INTO krusch_blobs (sha256, content, byte_size, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (sha256) DO NOTHING`,
        [hash, stagedContent, Buffer.byteLength(stagedContent, 'utf-8')]
      );
      if (originalHash && originalContent) {
        await query(
          `INSERT INTO krusch_blobs (sha256, content, byte_size, created_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (sha256) DO NOTHING`,
          [originalHash, originalContent, Buffer.byteLength(originalContent, 'utf-8')]
        );
      }
    } catch (blobErr) {
      console.warn(`[KruschStateManager] Non-fatal blob deduplication store warning: ${blobErr.message}`);
    }

    return res.rows[0];
  }

  /**
   * Prune all active leases that have exceeded their TTL.
   */
  static async pruneExpiredLeases() {
    const res = await query(`
      UPDATE krusch_staged_diffs
      SET status = 'REJECTED'
      WHERE status IN ('PENDING', 'APPLIED')
        AND (
          lease_expires_at < NOW()
          OR (lease_expires_at IS NULL AND created_at < NOW() - INTERVAL '15 minutes')
        )
      RETURNING id, task_id, file_path, project_path, lease_expires_at;
    `);

    for (const row of res.rows) {
      await KruschStateManager.recordEvent(row.task_id, null, 'lease_expired', {
        diffId: row.id,
        filePath: row.file_path,
        expiredAt: row.lease_expires_at,
        reason: 'Lease TTL expired during pruning'
      });
    }

    return res.rows;
  }

  /**
   * Explicitly release/unlock a file lease held by a task.
   */
  static async releaseLease(taskId, filePath, projectPath = null) {
    let targetProject = projectPath || process.cwd();
    const canonical = canonicalizePaths(targetProject, filePath);

    const res = await query(`
      UPDATE krusch_staged_diffs
      SET status = 'REJECTED'
      WHERE project_path = $1 AND file_path = $2 AND task_id = $3 AND status IN ('PENDING', 'APPLYING', 'APPLIED')
      RETURNING id, task_id, file_path;
    `, [canonical.projectPath, canonical.filePath, taskId]);

    if (res.rows.length > 0) {
      await KruschStateManager.recordEvent(taskId, null, 'lease_unlocked_manual', {
        filePath: canonical.filePath,
        diffId: res.rows[0].id
      });
    }

    return res.rows[0] || null;
  }

  /**
   * List all currently active leases in the system.
   */
  static async listActiveLeases(projectPath = null) {
    let sql = `
      SELECT id, task_id, project_path, file_path, status, sha256_hash, created_at, lease_expires_at,
             (lease_expires_at < NOW()) as is_expired,
             ROUND(EXTRACT(EPOCH FROM (lease_expires_at - NOW()))) as seconds_remaining
      FROM krusch_staged_diffs
      WHERE status IN ('PENDING', 'APPLYING', 'APPLIED')
    `;
    const params = [];
    if (projectPath) {
      const canonical = canonicalizePaths(projectPath, '.');
      sql += ' AND project_path = $1';
      params.push(canonical.projectPath);
    }
    sql += ' ORDER BY created_at DESC;';
    const res = await query(sql, params);
    return res.rows;
  }

  /**
   * Startup Crash Recovery:
   * Inspects all staged diffs left in 'APPLYING' state across the system or project.
   * Evaluates batches grouped by task_id to enforce atomic multi-file apply semantics:
   * 1. Complete rename -> mark APPLIED, clean temp files
   * 2. No rename -> revert to PENDING, clean temp files, disk untouched
   * 3. Drift detected -> mark REJECTED, clean temp files, disk preserved without overwrite
   * 4. Partial batch crash -> roll back already renamed files to base content, unlink temp files,
   *    and revert all diffs in batch to PENDING.
   */
  static async recoverInFlightApplies(projectPath = null, options = {}) {
    const fsOps = options?.fsOps || fs;
    const queryFn = options?.queryFn || query;
    const withTxFn = options?.withTransactionFn || withTransaction;

    const canonicalFilter = projectPath ? canonicalizePaths(projectPath, '.').projectPath : null;
    const rawResolved = projectPath ? path.resolve(projectPath).split(path.sep).join('/') : null;

    let journalSql = `SELECT * FROM krusch_apply_journal WHERE state = 'APPLYING' ORDER BY id ASC`;
    const journalParams = [];
    if (canonicalFilter) {
      if (rawResolved && rawResolved !== canonicalFilter) {
        journalSql = `SELECT * FROM krusch_apply_journal WHERE state = 'APPLYING' AND project_path IN ($1, $2) ORDER BY id ASC`;
        journalParams.push(canonicalFilter, rawResolved);
      } else {
        journalSql = `SELECT * FROM krusch_apply_journal WHERE state = 'APPLYING' AND project_path = $1 ORDER BY id ASC`;
        journalParams.push(canonicalFilter);
      }
    }
    const journalRes = await queryFn(journalSql, journalParams);

    let diffSql = `SELECT * FROM krusch_staged_diffs WHERE status = 'APPLYING' ORDER BY id ASC`;
    const diffParams = [];
    if (canonicalFilter) {
      diffSql = `SELECT * FROM krusch_staged_diffs WHERE status = 'APPLYING' AND project_path = $1 ORDER BY id ASC`;
      diffParams.push(canonicalFilter);
    }
    const diffRes = await queryFn(diffSql, diffParams);

    const allDiffs = [...diffRes.rows];
    const seenDiffIds = new Set(allDiffs.map(d => d.id));
    const journalEntryByDiffId = new Map();
    const missingDiffIds = new Set();
    const journalDiffIdsByRowId = new Map();

    for (const journalRow of journalRes.rows) {
      const entries = parseJournalFiles(journalRow.files);
      const rowDiffIds = [];
      for (const entry of entries) {
        if (entry && entry.diffId !== undefined && entry.diffId !== null) {
          const idNum = Number(entry.diffId);
          if (Number.isInteger(idNum)) {
            rowDiffIds.push(idNum);
            journalEntryByDiffId.set(idNum, entry);
            if (!seenDiffIds.has(idNum)) {
              missingDiffIds.add(idNum);
            }
          }
        }
      }
      journalDiffIdsByRowId.set(journalRow.id, rowDiffIds);
    }

    if (missingDiffIds.size > 0) {
      const extraRes = await queryFn(
        `SELECT * FROM krusch_staged_diffs WHERE id = ANY($1::int[]) ORDER BY id ASC`,
        [Array.from(missingDiffIds)]
      );
      for (const row of extraRes.rows) {
        if (!seenDiffIds.has(row.id) && ['PENDING', 'APPLYING', 'APPLIED'].includes(row.status)) {
          seenDiffIds.add(row.id);
          allDiffs.push(row);
        }
      }
      allDiffs.sort((a, b) => a.id - b.id);
    }

    // Group diffs by task_id to evaluate multi-file batch atomicity
    const taskGroups = new Map();
    for (const diff of allDiffs) {
      if (!taskGroups.has(diff.task_id)) {
        taskGroups.set(diff.task_id, []);
      }
      taskGroups.get(diff.task_id).push(diff);
    }

    // Close any orphaned active journal row that has zero matching active staged diffs
    for (const journalRow of journalRes.rows) {
      const rowDiffIds = journalDiffIdsByRowId.get(journalRow.id) || [];
      const hasActiveDiffs = rowDiffIds.some(id => seenDiffIds.has(id)) || taskGroups.has(journalRow.task_id);
      if (!hasActiveDiffs) {
        await queryFn(
          `UPDATE krusch_apply_journal
           SET state = 'ROLLED_BACK', completed_at = NOW(), error_message = COALESCE(error_message, 'Orphaned apply journal with no matching staged diffs')
           WHERE id = $1 AND state = 'APPLYING'`,
          [journalRow.id]
        );
      }
    }

    if (taskGroups.size === 0) return [];

    const recovered = [];

    for (const [taskId, batchDiffs] of taskGroups.entries()) {
      let inspected;
      try {
        inspected = batchDiffs.map(diff => {
          const journalEntry = journalEntryByDiffId.get(diff.id) || null;
          const stagedHash = journalEntry?.stagedHash ?? diff.sha256_hash;
          const originalHash = (journalEntry && 'originalHash' in journalEntry)
            ? journalEntry.originalHash
            : diff.original_sha256;
          const originalContent = (journalEntry && 'originalContent' in journalEntry)
            ? journalEntry.originalContent
            : diff.original_content;
          const fullPath = journalEntry?.fullPath || path.resolve(diff.project_path, diff.file_path);
          const existedAtStage = (journalEntry && 'diskExisted' in journalEntry)
            ? Boolean(journalEntry.diskExisted)
            : (originalContent === '');

          const { exists: diskExists, content: diskContent } = readTextIfExists(fullPath, fsOps);
          const diskHash = diskExists
            ? crypto.createHash('sha256').update(diskContent).digest('hex')
            : null;

          const isRenamed = diskExists && diskHash === stagedHash;
          const isUntouched = originalHash
            ? (diskExists && diskHash === originalHash)
            : (existedAtStage ? (diskExists && diskContent === '') : !diskExists);
          const isDrift = !isRenamed && !isUntouched;

          return {
            diff,
            journalEntry,
            stagedHash,
            originalHash,
            originalContent,
            existedAtStage,
            fullPath,
            diskExists,
            diskHash,
            isRenamed,
            isUntouched,
            isDrift
          };
        });

        // Clean orphaned temp files for all files in this batch (propagating directory EIO/EACCES)
        for (const item of inspected) {
          cleanOrphanedTempFiles(item.fullPath, fsOps, { throwOnIoError: true });
        }
      } catch (inspectIoErr) {
        try {
          await queryFn(
            `UPDATE krusch_apply_journal SET error_message = $1 WHERE task_id = $2 AND state = 'APPLYING'`,
            [`COMPOUND_RECOVERY_IO_ERROR: ${inspectIoErr.message}`, taskId]
          );
        } catch (dbErr) {
          console.error(`[KruschStateManager] Failed to update journal error_message during recovery inspection for task ${taskId}: ${dbErr.message}`);
        }
        try {
          await queryFn(
            `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
             VALUES ($1, NULL, 'recovery_deferred_io_error', $2, NOW())`,
            [taskId, JSON.stringify({ error: inspectIoErr.message, code: inspectIoErr.code || null, phase: 'inspect' })]
          );
        } catch (dbErr) {
          console.error(`[KruschStateManager] Failed to record recovery_deferred_io_error event for task ${taskId}: ${dbErr.message}`);
        }

        if (options?.strict === true) {
          throw inspectIoErr;
        }
        recovered.push({
          taskId,
          outcome: 'RECOVERY_DEFERRED_IO_ERROR',
          error: inspectIoErr.message
        });
        continue;
      }

      const anyDrift = inspected.some(i => i.isDrift);
      const allRenamed = inspected.every(i => i.isRenamed);
      const allUntouched = inspected.every(i => i.isUntouched);

      if (anyDrift) {
        // Case 3: Drift detected on one or more files in the batch
        const batchRecovered = [];
        await withTxFn(async (client) => {
          for (const item of inspected) {
            if (item.isDrift) {
              await client.query(`UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE id = $1`, [item.diff.id]);
              await client.query(
                `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
                 VALUES ($1, NULL, 'drift_detected', $2, NOW())`,
                [taskId, JSON.stringify({
                  diffId: item.diff.id,
                  filePath: item.diff.file_path,
                  outcome: 'DRIFT_DETECTED_REJECTED',
                  diskHash: item.diskHash,
                  stagedHash: item.stagedHash,
                  originalHash: item.originalHash,
                  reason: 'Disk contents modified out-of-band during crash recovery'
                })]
              );
              batchRecovered.push({ id: item.diff.id, filePath: item.diff.file_path, outcome: 'DRIFT_REJECTED' });
            } else {
              await client.query(`UPDATE krusch_staged_diffs SET status = 'PENDING' WHERE id = $1`, [item.diff.id]);
              batchRecovered.push({ id: item.diff.id, filePath: item.diff.file_path, outcome: 'REVERTED_TO_PENDING' });
            }
          }
          await client.query(
            `UPDATE krusch_apply_journal
             SET state = 'FAILED', completed_at = NOW(), error_message = COALESCE(error_message, 'Working tree drift detected during crash recovery')
             WHERE task_id = $1 AND state = 'APPLYING'`,
            [taskId]
          );
        });
        recovered.push(...batchRecovered);
      } else if (allRenamed) {
        // Case 1: Complete rename across all files in the batch
        const batchRecovered = [];
        await withTxFn(async (client) => {
          for (const item of inspected) {
            await client.query(`UPDATE krusch_staged_diffs SET status = 'APPLIED', applied_at = NOW() WHERE id = $1`, [item.diff.id]);
            await client.query(
              `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
               VALUES ($1, NULL, 'recovery_performed', $2, NOW())`,
              [taskId, JSON.stringify({
                diffId: item.diff.id,
                filePath: item.diff.file_path,
                outcome: 'MARKED_APPLIED',
                reason: 'Live disk file matched staged content SHA-256'
              })]
            );
            batchRecovered.push({ id: item.diff.id, filePath: item.diff.file_path, outcome: 'APPLIED' });
          }
          await client.query(
            `UPDATE krusch_apply_journal SET state = 'APPLIED', completed_at = NOW(), error_message = NULL WHERE task_id = $1 AND state = 'APPLYING'`,
            [taskId]
          );
        });
        recovered.push(...batchRecovered);
      } else if (allUntouched) {
        // Case 2: No rename occurred across all files in the batch
        const batchRecovered = [];
        await withTxFn(async (client) => {
          for (const item of inspected) {
            await client.query(`UPDATE krusch_staged_diffs SET status = 'PENDING' WHERE id = $1`, [item.diff.id]);
            await client.query(
              `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
               VALUES ($1, NULL, 'recovery_performed', $2, NOW())`,
              [taskId, JSON.stringify({
                diffId: item.diff.id,
                filePath: item.diff.file_path,
                outcome: 'REVERTED_TO_PENDING',
                reason: 'Live disk file matched original base SHA-256; reverted to PENDING'
              })]
            );
            batchRecovered.push({ id: item.diff.id, filePath: item.diff.file_path, outcome: 'REVERTED_TO_PENDING' });
          }
          await client.query(
            `UPDATE krusch_apply_journal SET state = 'ROLLED_BACK', completed_at = NOW(), error_message = NULL WHERE task_id = $1 AND state = 'APPLYING'`,
            [taskId]
          );
        });
        recovered.push(...batchRecovered);
      } else {
        // Case 4: Partial batch crash! Some files were renamed, others were not.
        // 1. First validate ALL base preimage hashes BEFORE mutating disk.
        for (const item of inspected) {
          if (item.isRenamed && item.originalHash) {
            if (item.originalContent === null || item.originalContent === undefined) {
              throw new Error(
                `CORRUPT_BASE_PREIMAGE: missing original_content for recorded base SHA-256 (${item.originalHash}) on file '${item.diff.file_path}'`
              );
            }
            const preimageHash = crypto.createHash('sha256').update(item.originalContent).digest('hex');
            if (preimageHash !== item.originalHash) {
              throw new Error(
                `CORRUPT_BASE_PREIMAGE: stored original_content SHA-256 (${preimageHash}) does not match recorded base SHA-256 (${item.originalHash}) for file '${item.diff.file_path}'`
              );
            }
          }
        }

        // 2. Perform ALL physical disk rollbacks before touching DB status.
        try {
          for (const item of inspected) {
            if (item.isRenamed) {
              if (item.originalHash || item.existedAtStage) {
                atomicWriteFile(item.fullPath, item.originalContent ?? '', fsOps);
              } else {
                const unlinked = unlinkIfExists(item.fullPath, fsOps);
                if (unlinked) {
                  fsyncDirectory(path.dirname(item.fullPath), fsOps);
                }
              }
            }
          }
        } catch (ioErr) {
          // 3. Compound I/O fault during disk rollback: preserve APPLYING state so next recovery heals remaining files!
          try {
            await queryFn(
              `UPDATE krusch_apply_journal SET error_message = $1 WHERE task_id = $2 AND state = 'APPLYING'`,
              [`COMPOUND_RECOVERY_IO_ERROR: ${ioErr.message}`, taskId]
            );
          } catch (dbErr) {
            console.error(`[KruschStateManager] Failed to update journal error_message during recovery for task ${taskId}: ${dbErr.message}`);
          }
          try {
            await queryFn(
              `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
               VALUES ($1, NULL, 'recovery_deferred_io_error', $2, NOW())`,
              [taskId, JSON.stringify({ error: ioErr.message, code: ioErr.code || null, phase: 'rollback' })]
            );
          } catch (dbErr) {
            console.error(`[KruschStateManager] Failed to record recovery_deferred_io_error event for task ${taskId}: ${dbErr.message}`);
          }

          if (options?.strict === true) {
            throw ioErr;
          }
          recovered.push({
            taskId,
            outcome: 'RECOVERY_DEFERRED_IO_ERROR',
            error: ioErr.message
          });
          continue;
        }

        // 4. Commit PENDING status + ROLLED_BACK journal atomically after all disk rollbacks succeed.
        const batchRecovered = [];
        await withTxFn(async (client) => {
          for (const item of inspected) {
            await client.query(`UPDATE krusch_staged_diffs SET status = 'PENDING' WHERE id = $1`, [item.diff.id]);
            await client.query(
              `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
               VALUES ($1, NULL, 'recovery_performed', $2, NOW())`,
              [taskId, JSON.stringify({
                diffId: item.diff.id,
                filePath: item.diff.file_path,
                outcome: 'BATCH_ROLLBACK_REVERTED_TO_PENDING',
                wasRenamed: item.isRenamed,
                reason: 'Partial batch apply detected on crash recovery; atomically rolled back renamed files to base content'
              })]
            );
            batchRecovered.push({
              id: item.diff.id,
              filePath: item.diff.file_path,
              outcome: 'BATCH_ROLLBACK_REVERTED_TO_PENDING'
            });
          }
          await client.query(
            `UPDATE krusch_apply_journal SET state = 'ROLLED_BACK', completed_at = NOW(), error_message = NULL WHERE task_id = $1 AND state = 'APPLYING'`,
            [taskId]
          );
        });
        recovered.push(...batchRecovered);
      }
    }

    return recovered;
  }

  /**
   * Apply multiple staged diffs as a single atomic unit (all files or none).
   * Enforces verification requirements, pre-commit drift checks, journaled APPLYING state,
   * tempfile fsync, parent directory fsync, and compound-fault-safe rollback.
   */
  static async applyDiffBatch(taskId, diffIds = null, projectPath = null, options = {}) {
    const fsOps = options?.fsOps || fs;
    const queryFn = options?.queryFn || query;
    const withTxFn = options?.withTransactionFn || withTransaction;

    const task = await KruschStateManager.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    if (task.phase !== 'APPROVAL_GATE') {
      throw new Error(`Cannot apply staged diffs: Task '${taskId}' is in '${task.phase}' phase (must be APPROVAL_GATE).`);
    }

    const latestVerif = await KruschStateManager.getLatestVerificationRun(taskId);
    if (!latestVerif || !latestVerif.passed || latestVerif.exit_code !== 0) {
      throw new Error(`Refusing to apply diffs: Ground-truth verification is failing (Exit code: ${latestVerif?.exit_code ?? 'none'}).`);
    }

    const baseProject = projectPath || task.project_path || process.cwd();
    const canonicalBaseProject = canonicalizePaths(baseProject, '.').projectPath;

    // Pre-flight compound-recovery check: reconcile any residual APPLYING rows or journal entries from a prior crash/compound-rollback failure
    let promotedInPreFlight = [];
    const inFlightRes = await queryFn(
      `SELECT id FROM krusch_staged_diffs WHERE task_id = $1 AND status = 'APPLYING' ORDER BY id ASC`,
      [taskId]
    );
    const inFlightJournalRes = await queryFn(
      `SELECT id, files FROM krusch_apply_journal WHERE task_id = $1 AND state = 'APPLYING' ORDER BY id ASC`,
      [taskId]
    );
    if (inFlightRes.rows.length > 0 || inFlightJournalRes.rows.length > 0) {
      const inFlightIds = new Set(inFlightRes.rows.map(r => r.id));
      for (const jRow of inFlightJournalRes.rows) {
        for (const entry of parseJournalFiles(jRow.files)) {
          if (entry && entry.diffId !== undefined && entry.diffId !== null) {
            const idNum = Number(entry.diffId);
            if (Number.isInteger(idNum)) {
              inFlightIds.add(idNum);
            }
          }
        }
      }
      const rec = await KruschStateManager.recoverInFlightApplies(canonicalBaseProject, { ...options, strict: true });
      promotedInPreFlight = rec.filter(
        r => r.outcome === 'APPLIED' && inFlightIds.has(r.id) && (!diffIds || diffIds.includes(r.id))
      );
    }

    // Refuse apply if any requested or active diff is REJECTED
    if (diffIds && diffIds.length > 0) {
      const explicitRows = await queryFn(`SELECT id, status, file_path FROM krusch_staged_diffs WHERE id = ANY($1::int[])`, [diffIds]);
      const rejected = explicitRows.rows.find(r => r.status === 'REJECTED');
      if (rejected) {
        throw new Error(`Refusing to apply diff ${rejected.id} for '${rejected.file_path}': staged diff has been REJECTED (e.g. working tree drift detected). It must be re-staged and re-verified.`);
      }
    } else {
      const rejectedRows = await queryFn(`SELECT id, status, file_path FROM krusch_staged_diffs WHERE task_id = $1 AND status = 'REJECTED'`, [taskId]);
      if (rejectedRows.rows.length > 0) {
        throw new Error(`Refusing to apply diffs: Task '${taskId}' has ${rejectedRows.rows.length} REJECTED staged diff(s) (e.g. '${rejectedRows.rows[0].file_path}'). Modifications must be re-staged and re-verified before applying.`);
      }
    }

    const pendingRes = await queryFn(
      `SELECT * FROM krusch_staged_diffs WHERE task_id = $1 AND status = 'PENDING' ORDER BY id ASC`,
      [taskId]
    );
    const pendingDiffs = pendingRes.rows;
    const targets = diffIds
      ? pendingDiffs.filter(d => diffIds.includes(d.id))
      : pendingDiffs;

    if (targets.length === 0) {
      if (promotedInPreFlight.length > 0) {
        return {
          status: 'APPLIED',
          appliedCount: promotedInPreFlight.length,
          diffs: promotedInPreFlight.map(r => ({ id: r.id, filePath: r.filePath }))
        };
      }
      return { status: 'NOOP', appliedCount: 0, message: 'No pending staged diffs to apply.' };
    }

    // Step 1: Pre-Commit Drift Detection across ALL target files before mutating disk
    const verifiedTargets = [];
    for (const diff of targets) {
      const canonical = canonicalizePaths(baseProject, diff.file_path);
      const fullPath = path.resolve(canonical.projectPath, canonical.filePath);
      const targetDir = path.dirname(fullPath);

      const { exists: diskExists, content: diskContent } = readTextIfExists(fullPath, fsOps);
      const diskHash = (diskContent !== null && diskContent !== '')
        ? crypto.createHash('sha256').update(diskContent).digest('hex')
        : null;

      const expectedHash = diff.original_sha256 || null;
      if (diskHash !== expectedHash) {
        await queryFn(
          `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
           VALUES ($1, NULL, 'drift_detected', $2, NOW())`,
          [taskId, JSON.stringify({
            diffId: diff.id,
            filePath: diff.file_path,
            expectedHash,
            currentDiskHash: diskHash
          })]
        );
        const driftErr = new Error(
          `Refusing to apply staged diff to disk: working tree file '${diff.file_path}' was modified after diff was staged. Expected base hash: ${expectedHash || 'none'}, current disk hash: ${diskHash || 'none'}. Staged diff must be rebased and re-verified.`
        );
        driftErr.code = 'WORKING_TREE_DRIFT_DETECTED';
        throw driftErr;
      }

      verifiedTargets.push({
        diff,
        fullPath,
        targetDir,
        originalContent: diskContent,
        diskExisted: diskExists
      });
    }

    // Step 2: Write temporary sibling files and fsync to storage media (closing fd & unlinking all temp files on error)
    const preparedFiles = [];
    try {
      for (const item of verifiedTargets) {
        fsOps.mkdirSync(item.targetDir, { recursive: true });
        const randSuffix = crypto.randomBytes(4).toString('hex');
        const tempPath = path.resolve(item.targetDir, `.${path.basename(item.fullPath)}.krusch-tmp-${Date.now()}-${randSuffix}`);
        const fd = fsOps.openSync(tempPath, 'w');
        try {
          let writeErr = null;
          try {
            writeAllSync(fd, item.diff.staged_content, tempPath, fsOps);
            fsOps.fsyncSync(fd);
          } catch (err) {
            writeErr = err;
            throw err;
          } finally {
            try {
              fsOps.closeSync(fd);
            } catch (closeErr) {
              if (!writeErr) {
                throw closeErr;
              }
              console.warn(`[KruschStateManager] Failed to close temp fd for ${tempPath}: ${closeErr.message}`);
            }
          }
        } catch (tempErr) {
          try {
            fsOps.unlinkSync(tempPath);
          } catch (unlinkErr) {
            if (unlinkErr && unlinkErr.code !== 'ENOENT') {
              console.warn(`[KruschStateManager] Failed to unlink failed temp file ${tempPath}: ${unlinkErr.message}`);
            }
          }
          throw tempErr;
        }

        preparedFiles.push({
          diff: item.diff,
          tempPath,
          fullPath: item.fullPath,
          originalContent: item.originalContent,
          diskExisted: item.diskExisted
        });
      }
    } catch (prepErr) {
      for (const prep of preparedFiles) {
        try {
          fsOps.unlinkSync(prep.tempPath);
        } catch (unlinkErr) {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            console.warn(`[KruschStateManager] Failed to unlink prepared temp file ${prep.tempPath}: ${unlinkErr.message}`);
          }
        }
      }
      throw prepErr;
    }

    const targetIds = targets.map(d => d.id);

    // Step 3: Write durable Two-Phase Commit Apply Journal in PostgreSQL atomically with APPLYING status intent
    const journalPayload = preparedFiles.map(f => ({
      diffId: f.diff.id,
      filePath: f.diff.file_path,
      stagedHash: f.diff.sha256_hash,
      originalHash: f.diff.original_sha256,
      originalContent: f.originalContent ?? null,
      diskExisted: Boolean(f.diskExisted),
      fullPath: f.fullPath
    }));

    const withJournalTxFn = options?.withJournalTransactionFn || withTransaction;
    let journalId;
    try {
      await withJournalTxFn(async (client) => {
        const journalRes = await client.query(`
          INSERT INTO krusch_apply_journal (task_id, project_path, state, files, created_at)
          VALUES ($1, $2, 'APPLYING', $3, NOW())
          RETURNING id;
        `, [taskId, canonicalBaseProject, JSON.stringify(journalPayload)]);
        journalId = journalRes.rows[0]?.id;

        // Journal APPLYING intent on staged diffs
        await client.query(`UPDATE krusch_staged_diffs SET status = 'APPLYING' WHERE id = ANY($1::int[])`, [targetIds]);
        for (const diff of targets) {
          await client.query(
            `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
             VALUES ($1, NULL, 'apply_started', $2, NOW())`,
            [taskId, JSON.stringify({
              diffId: diff.id,
              filePath: diff.file_path,
              journalId
            })]
          );
        }
      });
    } catch (journalErr) {
      for (const prep of preparedFiles) {
        try {
          fsOps.unlinkSync(prep.tempPath);
        } catch (unlinkErr) {
          if (unlinkErr && unlinkErr.code !== 'ENOENT') {
            console.warn(`[KruschStateManager] Failed to unlink temp file ${prep.tempPath} after journal error: ${unlinkErr.message}`);
          }
        }
      }
      throw journalErr;
    }

    // Test hook for deterministic mid-apply crash testing before any rename (strictly test-only)
    const allowHooks = process.env.NODE_ENV === 'test' ||
      process.env.KRUSCH_ENABLE_TEST_HOOKS === '1' ||
      process.env.KRUSCH_ENABLE_TEST_HOOKS === 'true' ||
      process.env.npm_lifecycle_event === 'test';
    if (allowHooks && process.env.KRUSCH_TEST_HOOK_PAUSE_BEFORE_RENAME) {
      if (process.send) {
        process.send({ readyForKill: true });
      }
      if (process.env.KRUSCH_TEST_HOOK_MARKER_FILE) {
        try {
          fsOps.writeFileSync(process.env.KRUSCH_TEST_HOOK_MARKER_FILE, 'ready', 'utf-8');
        } catch (hookErr) {
          console.warn(`[KruschStateManager] Test hook marker write failed: ${hookErr.message}`);
        }
      }
      // Pause and await SIGKILL from parent test runner
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    // Step 4: Atomic POSIX Rename for all files with compound-fault-safe rollback on failure
    const renamedSoFar = [];
    try {
      for (const item of preparedFiles) {
        fsOps.renameSync(item.tempPath, item.fullPath);
        item.tempPath = null;
        renamedSoFar.push(item);
        fsyncDirectory(path.dirname(item.fullPath), fsOps);
        await queryFn(
          `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
           VALUES ($1, NULL, 'apply_fsync', $2, NOW())`,
          [taskId, JSON.stringify({
            diffId: item.diff.id,
            filePath: item.diff.file_path,
            journalId
          })]
        );

        // Test hook for deterministic mid-apply crash testing
        if (allowHooks && process.env.KRUSCH_TEST_HOOK_PAUSE_AFTER_FIRST_RENAME && renamedSoFar.length === 1) {
          if (process.send) {
            process.send({ readyForKill: true });
          }
          if (process.env.KRUSCH_TEST_HOOK_MARKER_FILE) {
            try {
              fsOps.writeFileSync(process.env.KRUSCH_TEST_HOOK_MARKER_FILE, 'ready', 'utf-8');
            } catch (hookErr) {
              console.warn(`[KruschStateManager] Test hook marker write failed: ${hookErr.message}`);
            }
          }
          if (process.env.KRUSCH_TEST_HOOK_SIMULATE_SIGKILL_IN_PROCESS === '1') {
            return { abortedMidBatch: true, signal: 'SIGKILL' };
          }
          // Pause and await SIGKILL from parent test runner
          await new Promise(resolve => setTimeout(resolve, 30000));
        }
      }
    } catch (renameErr) {
      const rollbackErrors = [];
      for (const item of renamedSoFar) {
        try {
          if (item.diskExisted) {
            atomicWriteFile(item.fullPath, item.originalContent ?? '', fsOps);
          } else {
            const unlinked = unlinkIfExists(item.fullPath, fsOps);
            if (unlinked) {
              fsyncDirectory(path.dirname(item.fullPath), fsOps);
            }
          }
        } catch (rbErr) {
          if (rbErr?.code !== 'ENOENT') {
            rollbackErrors.push({
              filePath: item.diff.file_path,
              error: rbErr.message,
              code: rbErr.code || null
            });
          }
        }
      }

      // Clean up remaining temp files
      for (const item of preparedFiles) {
        if (item.tempPath) {
          try {
            fsOps.unlinkSync(item.tempPath);
          } catch (cleanupErr) {
            if (cleanupErr?.code !== 'ENOENT') {
              console.warn(`[KruschStateManager] Failed to unlink temp file ${item.tempPath} after apply failure: ${cleanupErr.message}`);
            }
          }
          item.tempPath = null;
        }
      }

      if (rollbackErrors.length > 0) {
        // Case 4B: Compound failure during rollback!
        // Preserve APPLYING status in both krusch_staged_diffs and krusch_apply_journal so recovery heals torn disk state.
        const rollbackSummary = rollbackErrors.map(e => `${e.filePath}:${e.error}`).join(', ');
        const compoundMessage = `COMPOUND_ROLLBACK_FAILED: primary=${renameErr.message}; rollback=${rollbackSummary}`;
        if (journalId) {
          try {
            await queryFn(
              `UPDATE krusch_apply_journal SET error_message = $1 WHERE id = $2`,
              [compoundMessage, journalId]
            );
          } catch (dbErr) {
            console.error(`[KruschStateManager] Failed to update journal ${journalId} after compound rollback error: ${dbErr.message}`);
          }
        }
        try {
          await queryFn(
            `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
             VALUES ($1, NULL, 'apply_rollback_failed', $2, NOW())`,
            [taskId, JSON.stringify({
              primaryError: renameErr.message,
              rollbackErrors,
              targetIds,
              journalId
            })]
          );
        } catch (dbErr) {
          console.error(`[KruschStateManager] Failed to record apply_rollback_failed event for task ${taskId}: ${dbErr.message}`);
        }

        const compoundErr = new Error(compoundMessage);
        compoundErr.code = 'COMPOUND_ROLLBACK_FAILED';
        compoundErr.rollbackErrors = rollbackErrors;
        throw compoundErr;
      }

      // Case 4A: Clean single-fault rollback
      await withTxFn(async (client) => {
        if (journalId) {
          await client.query(
            `UPDATE krusch_apply_journal
             SET state = 'ROLLED_BACK', completed_at = NOW(), error_message = $1
             WHERE id = $2`,
            [renameErr.message, journalId]
          );
        }
        await client.query(
          `UPDATE krusch_staged_diffs SET status = 'PENDING' WHERE id = ANY($1::int[])`,
          [targetIds]
        );
        await client.query(
          `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
           VALUES ($1, NULL, 'apply_failed', $2, NOW())`,
          [taskId, JSON.stringify({
            error: renameErr.message,
            targetIds,
            journalId
          })]
        );
      });

      throw new Error(`MULTI_FILE_APPLY_FAILED: ${renameErr.message}`);
    }

    // Step 5: Atomically mark all rows as APPLIED in PostgreSQL and complete journal
    await withTxFn(async (client) => {
      await client.query(
        `UPDATE krusch_staged_diffs SET status = 'APPLIED', applied_at = NOW() WHERE id = ANY($1::int[])`,
        [targetIds]
      );
      if (journalId) {
        await client.query(
          `UPDATE krusch_apply_journal
           SET state = 'APPLIED', completed_at = NOW(), error_message = NULL
           WHERE id = $1`,
          [journalId]
        );
      }
      for (const diff of targets) {
        await client.query(
          `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
           VALUES ($1, NULL, 'apply_completed', $2, NOW())`,
          [taskId, JSON.stringify({
            diffId: diff.id,
            filePath: diff.file_path,
            journalId
          })]
        );
      }
    });

    return {
      status: 'APPLIED',
      appliedCount: targets.length,
      journalId,
      diffs: targets.map(d => ({ id: d.id, filePath: d.file_path }))
    };
  }

  /**
   * Explain the current task status, legal next transitions, and reasons for any blocked transitions.
   */
  static async explainTaskStatus(taskId) {
    const task = await KruschStateManager.getTask(taskId);
    if (!task) return null;

    const latestVerif = task.verifications[0] || null;
    const diffs = task.stagedDiffs;
    const pendingDiffs = diffs.filter(d => d.status === 'PENDING');
    const appliedDiffs = diffs.filter(d => d.status === 'APPLIED');
    const applyingDiffs = diffs.filter(d => d.status === 'APPLYING');

    const transitions = [
      { from: 'INIT', to: 'PLAN', reason: 'Context assembly and initial specialist selection.' },
      { from: 'INIT', to: 'ABORTED', reason: 'Explicit termination.' },
      { from: 'PLAN', to: 'IMPLEMENT', reason: 'Model emits staged file modifications.' },
      {
        from: 'PLAN',
        to: 'COMMITTED',
        invariant: diffs.length > 0 ? 'INV_NO_SHORTCUT_COMMITS' : null,
        reason: diffs.length > 0
          ? `BLOCKED: Cannot shortcut from PLAN to COMMITTED while staged diffs exist. Staged modifications must proceed through IMPLEMENT -> VERIFY -> APPROVAL_GATE.`
          : 'ALLOWED: Read-only task with zero staged diffs.'
      },
      { from: 'PLAN', to: 'ABORTED', reason: 'Explicit termination or turn budget exceeded.' },
      { from: 'IMPLEMENT', to: 'VERIFY', reason: 'Ground-truth test or verification command executed.' },
      { from: 'IMPLEMENT', to: 'ABORTED', reason: 'Explicit termination or loop detected.' },
      {
        from: 'VERIFY',
        to: 'APPROVAL_GATE',
        invariant: (!latestVerif || !latestVerif.passed || latestVerif.exit_code !== 0) ? 'INV_VERIFY_PASSED' : null,
        reason: !latestVerif
          ? 'BLOCKED: Cannot transition from VERIFY to APPROVAL_GATE without running at least one verification test'
          : (!latestVerif.passed || latestVerif.exit_code !== 0)
            ? `BLOCKED: Cannot transition to APPROVAL_GATE while ground-truth verification is failing (Exit Code: ${latestVerif.exit_code})`
            : `ALLOWED: Ground-truth tests passed (Run #${latestVerif.id}, Exit code: 0).`
      },
      { from: 'VERIFY', to: 'IMPLEMENT', reason: 'Test failed; model revising staged implementation.' },
      { from: 'VERIFY', to: 'ABORTED', reason: 'Verification budget exceeded or critical failure.' },
      {
        from: 'APPROVAL_GATE',
        to: 'COMMITTED',
        invariant: (pendingDiffs.length > 0 || applyingDiffs.length > 0)
          ? 'INV_NO_INCOMPLETE_COMMITS'
          : diffs.some(d => d.status === 'REJECTED')
            ? 'INV_NO_REJECTED_DIFFS'
            : null,
        reason: (pendingDiffs.length > 0 || applyingDiffs.length > 0)
          ? `BLOCKED: Cannot transition from APPROVAL_GATE to COMMITTED while unapplied staged diffs remain PENDING`
          : diffs.some(d => d.status === 'REJECTED')
            ? `BLOCKED: Cannot transition from APPROVAL_GATE to COMMITTED while staged diffs remain REJECTED`
            : 'ALLOWED: All staged diffs are applied to physical disk.'
      },
      { from: 'APPROVAL_GATE', to: 'IMPLEMENT', reason: 'User requested modifications.' },
      { from: 'APPROVAL_GATE', to: 'ABORTED', reason: 'User or policy rejected staged diffs.' }
    ];

    const currentTransitions = transitions.filter(t => t.from === task.phase);

    return {
      taskId: task.id,
      goal: task.goal,
      phase: task.phase,
      verificationCommand: task.verification_command || null,
      isTerminal: task.phase === 'COMMITTED' || task.phase === 'ABORTED',
      currentModel: task.current_model,
      latestVerification: latestVerif ? {
        id: latestVerif.id,
        command: latestVerif.command,
        passed: latestVerif.passed,
        exitCode: latestVerif.exit_code,
        failureModule: latestVerif.failure_module,
        durationMs: latestVerif.duration_ms
      } : null,
      diffSummary: {
        total: diffs.length,
        pending: pendingDiffs.length,
        applying: applyingDiffs.length,
        applied: appliedDiffs.length,
        committed: diffs.filter(d => d.status === 'COMMITTED').length,
        rejected: diffs.filter(d => d.status === 'REJECTED').length
      },
      possibleTransitions: currentTransitions
    };
  }

  /**
   * Format the output of explainTaskStatus as a deterministic human-readable string.
   */
  static formatExplainOutput(exp) {
    if (!exp) return 'Task not found.';
    const lines = [];
    lines.push(`📋 EXPLAIN DIAGNOSTIC: Task ${exp.taskId}`);
    lines.push(`Current Phase: ${exp.phase}${exp.isTerminal ? ' (Terminal)' : ''}`);
    lines.push(`Active Model:  ${exp.currentModel || 'none'}`);
    if (exp.verificationCommand) {
      lines.push(`Test Command:  ${exp.verificationCommand}`);
    }
    lines.push('');
    lines.push('Next Transition Feasibility:');
    for (const t of exp.possibleTransitions) {
      const isBlocked = t.reason.startsWith('BLOCKED');
      const icon = isBlocked ? '✗ BLOCKED' : '✓ ALLOWED';
      const invTag = t.invariant ? ` [${t.invariant}]` : '';
      lines.push(`  ${icon}${invTag} ${t.from} ➔ ${t.to}`);
      lines.push(`    ${t.reason}`);
    }
    return lines.join('\n');
  }

  /**
   * Get all pending staged diffs for a task.
   */
  static async getPendingDiffs(taskId) {
    const sql = `SELECT * FROM krusch_staged_diffs WHERE task_id = $1 AND status = 'PENDING' ORDER BY id ASC`;
    const res = await query(sql, [taskId]);
    return res.rows;
  }

  /**
   * Get all staged diffs for a task regardless of status.
   */
  static async getStagedDiffs(taskId) {
    const sql = `SELECT * FROM krusch_staged_diffs WHERE task_id = $1 ORDER BY id ASC`;
    const res = await query(sql, [taskId]);
    return res.rows;
  }

  /**
   * Get all active (PENDING, APPLYING, or APPLIED) staged diffs for a task.
   */
  static async getActiveDiffs(taskId) {
    const sql = `SELECT * FROM krusch_staged_diffs WHERE task_id = $1 AND status IN ('PENDING', 'APPLYING', 'APPLIED') ORDER BY id ASC`;
    const res = await query(sql, [taskId]);
    return res.rows;
  }

  /**
   * Update status of a staged diff (e.g. APPLIED, REJECTED).

   */
  static async updateDiffStatus(diffId, status) {
    const sql = `
      UPDATE krusch_staged_diffs
      SET status = $1::varchar(32), applied_at = (CASE WHEN $1::text = 'APPLIED' THEN NOW() ELSE NULL END)
      WHERE id = $2
      RETURNING *;
    `;
    const res = await query(sql, [status, diffId]);
    return res.rows[0];
  }

  /**
   * Request human-in-the-loop or policy approval.
   */
  static async requestApproval(taskId, { actionType, targetResource, requestedByModel, status = 'PENDING', decisionReason = null }) {
    const sql = `
      INSERT INTO krusch_approvals (task_id, action_type, target_resource, status, requested_by_model, decision_reason, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *;
    `;
    const res = await query(sql, [taskId, actionType, targetResource, status, requestedByModel, decisionReason]);
    return res.rows[0];
  }

  /**
   * Decide on an approval request.
   */
  static async decideApproval(approvalId, status, decisionReason) {
    const sql = `
      UPDATE krusch_approvals
      SET status = $1, decision_reason = $2, decided_at = NOW()
      WHERE id = $3
      RETURNING *;
    `;
    const res = await query(sql, [status, decisionReason, approvalId]);
    return res.rows[0];
  }

  /**
   * Record ground-truth test/verification execution.
   * Locks the parent task row with SELECT ... FOR UPDATE inside a transaction
   * to serialize concurrent runners and prevent race conditions with phase transitions.
   */
  static async recordVerificationRun(taskId, {
    command,
    exitCode,
    stdout,
    stderr,
    passed,
    failureModule = null,
    extractedErrors = [],
    sandboxType = 'process',
    sandboxConfig = {},
    envSnapshot = {},
    fileManifest = [],
    replayToken = null
  }, client = null) {
    const insertSql = `
      INSERT INTO krusch_verification_runs (
        task_id, command, exit_code, stdout, stderr, passed, failure_module, extracted_errors,
        sandbox_type, sandbox_config, env_snapshot, file_manifest, replay_token, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      RETURNING *;
    `;
    const params = [
      taskId,
      command,
      exitCode,
      stdout,
      stderr,
      passed,
      failureModule,
      JSON.stringify(extractedErrors || []),
      sandboxType || 'process',
      JSON.stringify(sandboxConfig || {}),
      JSON.stringify(envSnapshot || {}),
      JSON.stringify(fileManifest || []),
      replayToken || null
    ];

    if (client) {
      // Lock parent task row to serialize concurrent verification runners
      await client.query('SELECT id FROM krusch_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const res = await client.query(insertSql, params);
      return res.rows[0];
    } else {
      return await withTransaction(async (txClient) => {
        await txClient.query('SELECT id FROM krusch_tasks WHERE id = $1 FOR UPDATE', [taskId]);
        const res = await txClient.query(insertSql, params);
        return res.rows[0];
      });
    }
  }

  /**
   * Get the authoritative latest verification run for a task.
   */
  static async getLatestVerificationRun(taskId, client = null) {
    const sql = `
      SELECT * FROM krusch_verification_runs
      WHERE task_id = $1
      ORDER BY id DESC, created_at DESC
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [taskId]) : await query(sql, [taskId]);
    return res.rows[0] || null;
  }

  /**
   * Check if a task has any unapplied (PENDING) staged diffs.
   */
  static async hasUnappliedStagedDiffs(taskId, client = null) {
    const sql = `
      SELECT 1 FROM krusch_staged_diffs
      WHERE task_id = $1 AND status = 'PENDING'
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [taskId]) : await query(sql, [taskId]);
    return res.rows.length > 0;
  }

  /**
   * Check if a task has any staged diffs at all (regardless of status).
   */
  static async hasAnyStagedDiffs(taskId, client = null) {
    const sql = `
      SELECT 1 FROM krusch_staged_diffs
      WHERE task_id = $1
      LIMIT 1;
    `;
    const res = client ? await client.query(sql, [taskId]) : await query(sql, [taskId]);
    return res.rows.length > 0;
  }

  /**
   * Atomically record verification run and transition task phase under a single unbroken task row lock.
   */
  static async recordVerificationAndTransition(taskId, verifData, targetPhase = null, metadata = {}) {
    return await withTransaction(async (client) => {
      // 1. Lock task row in PostgreSQL (FOR UPDATE)
      const taskRes = await client.query('SELECT * FROM krusch_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (taskRes.rows.length === 0) {
        throw new Error(`Task '${taskId}' not found for verification run.`);
      }

      // 2. Insert verification run under the row lock
      const insertSql = `
        INSERT INTO krusch_verification_runs (
          task_id, command, exit_code, stdout, stderr, passed, failure_module, extracted_errors, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING *;
      `;
      const runRes = await client.query(insertSql, [
        taskId,
        verifData.command,
        verifData.exitCode,
        verifData.stdout,
        verifData.stderr,
        verifData.passed,
        verifData.failureModule || null,
        JSON.stringify(verifData.extractedErrors || [])
      ]);

      let transitionResult = null;
      if (targetPhase) {
        transitionResult = await KruschStateManager._executeTransitionInsideTransaction(
          client,
          taskRes.rows[0],
          targetPhase,
          [],
          null,
          metadata
        );
      }

      return {
        verificationRun: runRes.rows[0],
        transition: transitionResult
      };
    });
  }

  /**
   * Helper to perform phase transition logic inside an already-open transaction with row locked.
   * @private
   */
  static async _executeTransitionInsideTransaction(client, task, targetPhase, allowedSourcePhases = [], guardValidator = null, metadata = {}) {
    const currentPhase = task.phase;

    // Validate allowed transitions from the authoritative DB phase
    if (allowedSourcePhases.length > 0 && !allowedSourcePhases.includes(currentPhase)) {
      throw new Error(
        `Invalid FSM transition: cannot transition from ${currentPhase} to ${targetPhase}. Valid target states from ${currentPhase}: [${allowedSourcePhases.join(', ')}]`
      );
    }

    // Execute transactional guard validator
    if (guardValidator) {
      await guardValidator({ task, client, targetPhase });
    }

    // Update phase and metadata in PostgreSQL
    const updatedMetadata = {
      ...(task.metadata || {}),
      ...metadata,
      lastTransition: {
        from: currentPhase,
        to: targetPhase,
        timestamp: new Date().toISOString()
      }
    };

    const updateSql = `
      UPDATE krusch_tasks
      SET phase = $1, metadata = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING *;
    `;
    const updateRes = await client.query(updateSql, [targetPhase, JSON.stringify(updatedMetadata), task.id]);

    // Update staged diffs status upon terminal transitions
    if (targetPhase === 'COMMITTED') {
      await client.query(
        `UPDATE krusch_staged_diffs SET status = 'COMMITTED' WHERE task_id = $1 AND status = 'APPLIED'`,
        [task.id]
      );
    } else if (targetPhase === 'ABORTED') {
      await client.query(
        `UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE task_id = $1 AND status IN ('PENDING', 'APPLYING')`,
        [task.id]
      );
    }

    // Log transition event in krusch_events
    await client.query(`
      INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
      VALUES ($1, NULL, 'fsm_phase_transition', $2, NOW())
    `, [task.id, JSON.stringify({ from: currentPhase, to: targetPhase, metadata })]);

    return {
      from: currentPhase,
      to: targetPhase,
      task: updateRes.rows[0]
    };
  }

  /**
   * Atomically transition a task's FSM phase inside PostgreSQL using row-level locking.
   * Prevents multi-process drift and guarantees invariant validation before write.
   */
  static async atomicTransitionPhase(taskId, targetPhase, allowedSourcePhases = [], guardValidator = null, metadata = {}) {
    return await withTransaction(async (client) => {
      // 1. Lock task row in PostgreSQL (FOR UPDATE)
      const taskRes = await client.query('SELECT * FROM krusch_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      if (taskRes.rows.length === 0) {
        throw new Error(`Task '${taskId}' not found for atomic transition.`);
      }

      return await KruschStateManager._executeTransitionInsideTransaction(
        client,
        taskRes.rows[0],
        targetPhase,
        allowedSourcePhases,
        guardValidator,
        metadata
      );
    });
  }

  /**
   * Operator Action: Abort a task explicitly, release all held leases, and record event.
   */
  static async abortTask(taskId, reason = 'Aborted by operator') {
    const task = await KruschStateManager.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    if (task.phase === 'COMMITTED') {
      throw new Error(`Cannot abort task '${taskId}': task is already COMMITTED.`);
    }

    await withTransaction(async (client) => {
      // Release leases on any pending or active diffs
      await client.query(
        `UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE task_id = $1 AND status IN ('PENDING', 'APPLYING')`,
        [taskId]
      );

      // Transition task to ABORTED
      await client.query(
        `UPDATE krusch_tasks SET phase = 'ABORTED', metadata = metadata || $1::jsonb, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify({ abortReason: reason, abortedBy: 'operator', abortedAt: new Date().toISOString() }), taskId]
      );

      await client.query(
        `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [taskId, null, 'operator_abort', JSON.stringify({ previousPhase: task.phase, reason })]
      );
    });

    return { taskId, status: 'ABORTED', reason };
  }

  /**
   * Operator Action: Retry a failed or aborted task from a designated phase (VERIFY or IMPLEMENT).
   */
  static async retryTask(taskId, fromPhase = 'VERIFY', reason = 'Retried by operator') {
    const validPhases = ['PLAN', 'IMPLEMENT', 'VERIFY'];
    if (!validPhases.includes(fromPhase)) {
      throw new Error(`Invalid retry phase '${fromPhase}'. Allowed phases: ${validPhases.join(', ')}`);
    }

    const task = await KruschStateManager.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    if (task.phase === 'COMMITTED') {
      throw new Error(`Cannot retry task '${taskId}': task is already COMMITTED to physical disk.`);
    }

    await withTransaction(async (client) => {
      // Reset phase revisits and re-open diffs if retrying
      await client.query(
        `UPDATE krusch_tasks
         SET phase = $1, phase_revisits = 0, metadata = metadata || $2::jsonb, updated_at = NOW()
         WHERE id = $3`,
        [fromPhase, JSON.stringify({ retryReason: reason, retriedBy: 'operator', retriedAt: new Date().toISOString() }), taskId]
      );

      await client.query(
        `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [taskId, null, 'operator_retry', JSON.stringify({ previousPhase: task.phase, newPhase: fromPhase, reason })]
      );
    });

    return { taskId, status: fromPhase, reason };
  }

  /**
   * Operator Action: Explicitly reject one or all staged diffs for a task.
   */
  static async rejectStagedDiff(taskId, diffId = null, reason = 'Rejected by operator') {
    const task = await KruschStateManager.getTask(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found.`);

    await withTransaction(async (client) => {
      if (diffId) {
        await client.query(
          `UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE id = $1 AND task_id = $2`,
          [diffId, taskId]
        );
      } else {
        await client.query(
          `UPDATE krusch_staged_diffs SET status = 'REJECTED' WHERE task_id = $1 AND status = 'PENDING'`,
          [taskId]
        );
      }

      await client.query(
        `INSERT INTO krusch_events (task_id, turn_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [taskId, null, 'operator_reject_diff', JSON.stringify({ diffId, reason })]
      );
    });

    return { taskId, diffId, status: 'REJECTED', reason };
  }
}

