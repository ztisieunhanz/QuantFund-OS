// ============================================================================
// FILE: server/storage/sqliteStorage.ts
// MODULE: STATEFUL NODE SQLITE STORAGE FOUNDATION (M18-C1)
// NOTE: Single-node canonical SQLite storage engine using node:sqlite.
// ============================================================================

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { assertNodeRuntimeCompatibility } from "./runtimeCompatibility";
import { resolveDataDirectory, assertDataDirectory, resolveDatabasePath, DEFAULT_DB_FILENAME } from "./dataDirectory";
import { runMigrations, getAppliedMigrations, verifyC1SchemaBoundaries } from "./migrations";
import type {
  SqliteStorageConfig,
  StorageStatus,
  IntegrityCheckResult,
  BackupOptions,
  BackupResult,
  Migration,
} from "./types";

export { DEFAULT_DB_FILENAME };
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const MIN_BUSY_TIMEOUT_MS = 1000;
export const MAX_BUSY_TIMEOUT_MS = 60000;

export class SqliteStorage {
  private db: DatabaseSync | null = null;
  private isClosedState = false;
  private isReadyState = false;
  private resolvedDbPath = "";
  private appliedMigrationsCount = 0;
  private lastMigrationId: string | null = null;
  private currentJournalMode = "";
  private currentSynchronous = 0;
  private currentForeignKeys = false;
  private currentBusyTimeoutMs = 0;

  constructor(private readonly config: SqliteStorageConfig = {}) {}

  /**
   * Initializes and establishes the canonical SQLite database for production.
   * Performs runtime checks (using actual process.versions.node), directory validation,
   * pragma enforcement, deterministic migrations, and startup integrity validation.
   */
  public open(customMigrations?: readonly Migration[]): void {
    if (this.isClosedState) {
      throw new Error("STORAGE_CLOSED: Cannot open a closed storage instance.");
    }
    if (this.isReadyState && this.db) {
      return;
    }

    // 1. Production Runtime Compatibility Check (fail fast using actual process.versions.node)
    assertNodeRuntimeCompatibility();

    this.#initializeStorage(customMigrations);
  }

  #initializeStorage(customMigrations?: readonly Migration[]): void {
    // 2. Persistent Data Directory & Path Validation (fail closed, no escape)
    const dataDir = assertDataDirectory(
      resolveDataDirectory(this.config.dataDir, this.config.env)
    );
    this.resolvedDbPath = resolveDatabasePath(dataDir, this.config.databaseFilename);

    // 3. Open SQLite Database with deterministic failure cleanup
    try {
      this.db = new DatabaseSync(this.resolvedDbPath);
    } catch (err) {
      this.cleanupFailedOpen();
      throw new Error(
        `STORAGE_OPEN_FAILED: Failed to open SQLite database at '${this.resolvedDbPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    try {
      // 4. Apply & Verify Canonical Pragmas
      this.applyAndVerifyPragmas();

      // 5. Apply Bootstrap Migrations
      runMigrations(this.db, customMigrations);
      const applied = getAppliedMigrations(this.db);
      this.appliedMigrationsCount = applied.length;
      this.lastMigrationId = applied.length > 0 ? applied[applied.length - 1].id : null;

      // 6. Schema Boundary Guard
      const boundaryCheck = verifyC1SchemaBoundaries(this.db);
      if (!boundaryCheck.valid) {
        throw new Error(
          `C1_SCHEMA_VIOLATION: Found unauthorized future/controller tables in C1 database: ${boundaryCheck.disallowedFound.join(", ")}`
        );
      }

      // 7. Startup Quick Integrity Check
      const integrity = this.quickIntegrityCheck();
      if (!integrity.ok) {
        throw new Error(
          `STORAGE_CORRUPT: Initial database integrity check failed: ${integrity.error ?? integrity.details.join(", ")}`
        );
      }

      this.isReadyState = true;
    } catch (err) {
      this.cleanupFailedOpen();
      throw err;
    }
  }

  private cleanupFailedOpen(): void {
    this.isReadyState = false;
    this.appliedMigrationsCount = 0;
    this.lastMigrationId = null;
    this.currentJournalMode = "";
    this.currentSynchronous = 0;
    this.currentForeignKeys = false;
    this.currentBusyTimeoutMs = 0;

    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Suppress secondary close errors during cleanup
      }
      this.db = null;
    }
  }

  private applyAndVerifyPragmas(): void {
    if (!this.db) throw new Error("Database handle not initialized.");

    // A. PRAGMA journal_mode = WAL
    this.db.exec("PRAGMA journal_mode = WAL;");
    const jmRow = this.db.prepare("PRAGMA journal_mode;").get() as
      | { journal_mode?: string }
      | undefined;
    const jm = String(jmRow?.journal_mode || "").toLowerCase();
    if (jm !== "wal") {
      throw new Error(
        `PRAGMA_VERIFICATION_FAILED: Expected journal_mode 'wal', got '${jm}'.`
      );
    }
    this.currentJournalMode = jm;

    // B. PRAGMA synchronous = FULL
    this.db.exec("PRAGMA synchronous = FULL;");
    const syncRow = this.db.prepare("PRAGMA synchronous;").get() as
      | { synchronous?: number }
      | undefined;
    // In SQLite, FULL is represented numerically by 2
    const syncVal = Number(syncRow?.synchronous ?? -1);
    if (syncVal !== 2) {
      throw new Error(
        `PRAGMA_VERIFICATION_FAILED: Expected synchronous 2 (FULL), got '${syncVal}'.`
      );
    }
    this.currentSynchronous = syncVal;

    // C. PRAGMA foreign_keys = ON
    this.db.exec("PRAGMA foreign_keys = ON;");
    const fkRow = this.db.prepare("PRAGMA foreign_keys;").get() as
      | { foreign_keys?: number }
      | undefined;
    const fkVal = Number(fkRow?.foreign_keys ?? 0);
    if (fkVal !== 1) {
      throw new Error(
        `PRAGMA_VERIFICATION_FAILED: Expected foreign_keys 1 (ON), got '${fkVal}'.`
      );
    }
    this.currentForeignKeys = true;

    // D. PRAGMA busy_timeout = <ms>
    const rawTimeout = this.config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (
      typeof rawTimeout !== "number" ||
      !Number.isFinite(rawTimeout) ||
      !Number.isInteger(rawTimeout) ||
      rawTimeout < MIN_BUSY_TIMEOUT_MS ||
      rawTimeout > MAX_BUSY_TIMEOUT_MS
    ) {
      throw new Error(
        `INVALID_CONFIG: busyTimeoutMs must be an integer between ${MIN_BUSY_TIMEOUT_MS} and ${MAX_BUSY_TIMEOUT_MS} ms, got ${rawTimeout}.`
      );
    }
    this.db.exec(`PRAGMA busy_timeout = ${rawTimeout};`);
    const btRow = this.db.prepare("PRAGMA busy_timeout;").get() as
      | { timeout?: number }
      | undefined;
    const btVal = Number(btRow?.timeout ?? 0);
    if (btVal !== rawTimeout) {
      throw new Error(
        `PRAGMA_VERIFICATION_FAILED: Bounded busy_timeout verification failed, expected '${rawTimeout}', got '${btVal}'.`
      );
    }
    this.currentBusyTimeoutMs = btVal;
  }

  /**
   * Provides access to the underlying DatabaseSync instance.
   * Fails closed if storage is closed or not yet ready.
   */
  public getDb(): DatabaseSync {
    if (this.isClosedState) {
      throw new Error("STORAGE_CLOSED: Storage is closed. No operations allowed.");
    }
    if (!this.isReadyState || !this.db) {
      throw new Error("STORAGE_NOT_READY: Storage is not initialized. Call open() first.");
    }
    return this.db;
  }

  public getStatus(): StorageStatus {
    return {
      isReady: this.isReadyState,
      isClosed: this.isClosedState,
      dbPath: this.resolvedDbPath,
      journalMode: this.currentJournalMode,
      synchronous: this.currentSynchronous,
      foreignKeys: this.currentForeignKeys,
      busyTimeoutMs: this.currentBusyTimeoutMs,
      appliedMigrationsCount: this.appliedMigrationsCount,
      lastMigrationId: this.lastMigrationId,
    };
  }

  /**
   * Fast diagnostic suitable for health probes or startup checks.
   * Runs 'PRAGMA quick_check;'
   */
  public quickIntegrityCheck(): IntegrityCheckResult {
    if (this.isClosedState || !this.db) {
      return {
        ok: false,
        type: "quick",
        details: [],
        error: "Storage is closed or not initialized.",
      };
    }

    try {
      const rows = this.db.prepare("PRAGMA quick_check;").all() as unknown[];
      const details = rows.map((r) => {
        const obj = r as Record<string, unknown>;
        return String(obj.quick_check ?? Object.values(obj)[0] ?? "");
      });

      const isOk = details.length === 1 && details[0].toLowerCase() === "ok";
      return {
        ok: isOk,
        type: "quick",
        details,
        error: isOk ? undefined : `Integrity quick_check reported: ${details.join(", ")}`,
      };
    } catch (err) {
      return {
        ok: false,
        type: "quick",
        details: [],
        error: `Integrity quick_check failed with exception: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Comprehensive integrity diagnostic for explicit maintenance/tests.
   * Runs 'PRAGMA integrity_check;'
   */
  public fullIntegrityCheck(): IntegrityCheckResult {
    if (this.isClosedState || !this.db) {
      return {
        ok: false,
        type: "full",
        details: [],
        error: "Storage is closed or not initialized.",
      };
    }

    try {
      const rows = this.db.prepare("PRAGMA integrity_check;").all() as unknown[];
      const details = rows.map((r) => {
        const obj = r as Record<string, unknown>;
        return String(obj.integrity_check ?? Object.values(obj)[0] ?? "");
      });

      const isOk = details.length === 1 && details[0].toLowerCase() === "ok";
      return {
        ok: isOk,
        type: "full",
        details,
        error: isOk ? undefined : `Integrity full_check reported: ${details.join(", ")}`,
      };
    } catch (err) {
      return {
        ok: false,
        type: "full",
        details: [],
        error: `Integrity full_check failed with exception: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Performs an online SQLite backup using the official node:sqlite backup API.
   * Protects existing destination with failure-safe recovery preservation and verified staging.
   */
  public async backup(options: BackupOptions): Promise<BackupResult> {
    if (this.isClosedState || !this.db || !this.isReadyState) {
      throw new Error("STORAGE_NOT_READY: Cannot perform backup on unready or closed storage.");
    }

    if (!options.destinationPath || typeof options.destinationPath !== "string" || options.destinationPath.trim().length === 0) {
      throw new Error("BACKUP_PATH_INVALID: Backup destination path must be specified.");
    }

    const resolvedDest = path.resolve(options.destinationPath.trim());
    const canonicalSource = path.resolve(this.resolvedDbPath);

    // 1. Path identity check
    if (resolvedDest.toLowerCase() === canonicalSource.toLowerCase()) {
      throw new Error(
        `BACKUP_SOURCE_EQUALS_DESTINATION: Destination path '${resolvedDest}' cannot be the active database.`
      );
    }

    // 2. Filesystem identity check (symlink, hardlink, junction alias check against active source DB)
    if (fs.existsSync(resolvedDest) && fs.existsSync(canonicalSource)) {
      try {
        const realDest = fs.realpathSync(resolvedDest);
        const realSource = fs.realpathSync(canonicalSource);
        if (realDest.toLowerCase() === realSource.toLowerCase()) {
          throw new Error(
            `BACKUP_SOURCE_EQUALS_DESTINATION: Destination path '${resolvedDest}' is an alias/link to active database '${canonicalSource}'.`
          );
        }
      } catch (aliasErr) {
        if (aliasErr instanceof Error && aliasErr.message.startsWith("BACKUP_SOURCE_EQUALS_DESTINATION")) {
          throw aliasErr;
        }
        // If realpathSync fails for other reasons, proceed with cautious validation
      }

      try {
        const destStat = fs.statSync(resolvedDest);
        const srcStat = fs.statSync(canonicalSource);
        if (destStat.ino !== 0 && destStat.ino === srcStat.ino && destStat.dev === srcStat.dev) {
          throw new Error(
            `BACKUP_SOURCE_EQUALS_DESTINATION: Destination path '${resolvedDest}' shares filesystem identity with active database.`
          );
        }
      } catch (statErr) {
        if (statErr instanceof Error && statErr.message.startsWith("BACKUP_SOURCE_EQUALS_DESTINATION")) {
          throw statErr;
        }
      }
    }

    const destDir = path.dirname(resolvedDest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const destAlreadyExists = fs.existsSync(resolvedDest);
    if (destAlreadyExists && !options.overwrite) {
      throw new Error(
        `BACKUP_DESTINATION_EXISTS: Backup destination '${resolvedDest}' already exists and overwrite is false.`
      );
    }

    // 3. Stage backup into an exclusively unique sibling temporary file
    const uniqueToken = crypto.randomBytes(16).toString("hex");
    const tempBackupPath = path.join(destDir, `.tmp_backup_${uniqueToken}.db`);

    try {
      await sqliteBackup(this.db, tempBackupPath);
    } catch (err) {
      if (fs.existsSync(tempBackupPath)) {
        try { fs.unlinkSync(tempBackupPath); } catch { /* ignore */ }
      }
      throw new Error(
        `BACKUP_EXECUTION_FAILED: node:sqlite backup failed for '${resolvedDest}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!fs.existsSync(tempBackupPath)) {
      throw new Error(`BACKUP_VERIFICATION_FAILED: Temp backup file was not created at '${tempBackupPath}'.`);
    }

    // 4. Open temp backup independently and verify integrity & foundation schema
    let verifyHandle: DatabaseSync | null = null;
    try {
      verifyHandle = new DatabaseSync(tempBackupPath);
      const verifyCheck = verifyHandle.prepare("PRAGMA quick_check;").get() as Record<string, unknown> | undefined;
      const verifyVal = String(verifyCheck?.quick_check ?? Object.values(verifyCheck || {})[0] ?? "");
      if (verifyVal.toLowerCase() !== "ok") {
        throw new Error(`Backup file quick_check failed: ${verifyVal}`);
      }

      // Verify foundation schema is present and readable
      const schemaCheck = verifyHandle
        .prepare(
          "SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name IN ('_schema_metadata', '_schema_migrations');"
        )
        .get() as { count?: number } | undefined;
      if (!schemaCheck || Number(schemaCheck.count) < 2) {
        throw new Error("Backup file is missing required foundation tables.");
      }

      const versionRow = verifyHandle
        .prepare("SELECT value FROM _schema_metadata WHERE key = 'schema_version';")
        .get() as { value?: string } | undefined;
      if (!versionRow || versionRow.value !== "1") {
        throw new Error("Backup file foundation metadata is invalid or missing.");
      }
    } catch (verifyErr) {
      if (verifyHandle) {
        try { verifyHandle.close(); } catch { /* ignore */ }
        verifyHandle = null;
      }
      if (fs.existsSync(tempBackupPath)) {
        try { fs.unlinkSync(tempBackupPath); } catch { /* ignore */ }
      }
      throw new Error(
        `BACKUP_VERIFICATION_FAILED: Backup file verification failed: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`
      );
    } finally {
      if (verifyHandle) {
        try {
          verifyHandle.close();
        } catch {
          // ignore
        }
      }
    }

    // 5. Safe promotion with failure-safe recovery preservation
    if (!destAlreadyExists) {
      try {
        fs.renameSync(tempBackupPath, resolvedDest);
      } catch (renameErr) {
        if (fs.existsSync(tempBackupPath)) {
          try { fs.unlinkSync(tempBackupPath); } catch { /* ignore */ }
        }
        throw new Error(
          `BACKUP_PROMOTION_FAILED: Failed to promote backup to '${resolvedDest}': ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`
        );
      }
    } else {
      // Destination exists and overwrite is true:
      // Move old destination to a unique sibling recovery path first.
      const recoveryToken = crypto.randomBytes(16).toString("hex");
      const recoveryBackupPath = path.join(destDir, `.recovery_backup_${recoveryToken}.db`);

      try {
        fs.renameSync(resolvedDest, recoveryBackupPath);
      } catch (moveAsideErr) {
        if (fs.existsSync(tempBackupPath)) {
          try { fs.unlinkSync(tempBackupPath); } catch { /* ignore */ }
        }
        throw new Error(
          `BACKUP_PROMOTION_FAILED: Failed to move existing backup aside to '${recoveryBackupPath}': ${moveAsideErr instanceof Error ? moveAsideErr.message : String(moveAsideErr)}`
        );
      }

      // Promote temp backup to resolvedDest
      try {
        fs.renameSync(tempBackupPath, resolvedDest);
      } catch (promoteErr) {
        // Promotion failed: restore previous destination from recovery copy
        let restoreSucceeded = false;
        try {
          fs.renameSync(recoveryBackupPath, resolvedDest);
          restoreSucceeded = true;
        } catch (restoreErr) {
          // Restoration failed: recovery copy is preserved
          if (fs.existsSync(tempBackupPath)) {
            try { fs.unlinkSync(tempBackupPath); } catch { /* ignore */ }
          }
          throw new Error(
            `BACKUP_PROMOTION_FAILED: Failed to promote new backup AND failed to restore original backup (${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}). Original backup preserved at: '${recoveryBackupPath}'. Promotion error: ${promoteErr instanceof Error ? promoteErr.message : String(promoteErr)}`
          );
        }

        if (fs.existsSync(tempBackupPath)) {
          try { fs.unlinkSync(tempBackupPath); } catch { /* ignore */ }
        }

        if (restoreSucceeded) {
          throw new Error(
            `BACKUP_PROMOTION_FAILED: Failed to promote new backup to '${resolvedDest}'; original backup was preserved and restored. Error: ${promoteErr instanceof Error ? promoteErr.message : String(promoteErr)}`
          );
        }
      }

      // Successful promotion: remove recovery artifact
      try {
        if (fs.existsSync(recoveryBackupPath)) {
          fs.unlinkSync(recoveryBackupPath);
        }
      } catch {
        // Non-fatal if recovery unlink fails after successful promotion
      }
    }

    const stat = fs.statSync(resolvedDest);
    return {
      destinationPath: resolvedDest,
      bytesWritten: stat.size,
      completedAt: Date.now(),
    };
  }

  /**
   * Graceful database close.
   * Safe to call multiple times (idempotent).
   */
  public close(): void {
    if (this.isClosedState) {
      return;
    }
    this.isReadyState = false;
    this.isClosedState = true;

    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Safe close
      }
      this.db = null;
    }
  }
}
