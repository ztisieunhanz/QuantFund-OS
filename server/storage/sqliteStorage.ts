// ============================================================================
// FILE: server/storage/sqliteStorage.ts
// MODULE: STATEFUL NODE SQLITE STORAGE FOUNDATION (M18-C1)
// NOTE: Single-node canonical SQLite storage engine using node:sqlite.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNodeRuntimeCompatibility } from "./runtimeCompatibility";
import { resolveDataDirectory, assertDataDirectory } from "./dataDirectory";
import { runMigrations, getAppliedMigrations, verifyC1SchemaBoundaries } from "./migrations";
import type {
  SqliteStorageConfig,
  StorageStatus,
  IntegrityCheckResult,
  BackupOptions,
  BackupResult,
  Migration,
} from "./types";

export const DEFAULT_DB_FILENAME = "quantfund.db";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

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
   * Initializes and establishes the canonical SQLite database.
   * Performs runtime checks, directory validation, pragma enforcement,
   * deterministic migrations, and startup integrity validation.
   */
  public open(customMigrations?: readonly Migration[]): void {
    if (this.isClosedState) {
      throw new Error("STORAGE_CLOSED: Cannot open a closed storage instance.");
    }
    if (this.isReadyState && this.db) {
      return;
    }

    // 1. Runtime Compatibility Check (fail fast)
    assertNodeRuntimeCompatibility(undefined, { allowExperimentalSuperset: true });

    // 2. Persistent Data Directory Validation (fail closed)
    const dataDir = assertDataDirectory(
      resolveDataDirectory(this.config.dataDir, this.config.env)
    );
    const filename = this.config.databaseFilename?.trim() || DEFAULT_DB_FILENAME;
    this.resolvedDbPath = path.resolve(dataDir, filename);

    // 3. Open SQLite Database
    try {
      this.db = new DatabaseSync(this.resolvedDbPath);
    } catch (err) {
      throw new Error(
        `STORAGE_OPEN_FAILED: Failed to open SQLite database at '${this.resolvedDbPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

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
      this.close();
      throw new Error(
        `STORAGE_CORRUPT: Initial database integrity check failed: ${integrity.error ?? integrity.details.join(", ")}`
      );
    }

    this.isReadyState = true;
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
    const timeoutMs = this.config.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (timeoutMs < 1000) {
      throw new Error(
        `INVALID_CONFIG: busyTimeoutMs must be >= 1000ms, got ${timeoutMs}ms.`
      );
    }
    this.db.exec(`PRAGMA busy_timeout = ${timeoutMs};`);
    const btRow = this.db.prepare("PRAGMA busy_timeout;").get() as
      | { timeout?: number }
      | undefined;
    const btVal = Number(btRow?.timeout ?? 0);
    if (btVal <= 0) {
      throw new Error(
        `PRAGMA_VERIFICATION_FAILED: Bounded busy_timeout verification failed, got '${btVal}'.`
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
   * Performs an online SQLite backup using the canonical 'VACUUM INTO' mechanism.
   * The destination is validated and verified to be independently openable.
   */
  public backup(options: BackupOptions): BackupResult {
    if (this.isClosedState || !this.db || !this.isReadyState) {
      throw new Error("STORAGE_NOT_READY: Cannot perform backup on unready or closed storage.");
    }

    if (!options.destinationPath || typeof options.destinationPath !== "string") {
      throw new Error("BACKUP_PATH_INVALID: Backup destination path must be specified.");
    }

    const resolvedDest = path.resolve(options.destinationPath.trim());
    const destDir = path.dirname(resolvedDest);

    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (fs.existsSync(resolvedDest)) {
      if (!options.overwrite) {
        throw new Error(
          `BACKUP_DESTINATION_EXISTS: Backup destination '${resolvedDest}' already exists and overwrite is false.`
        );
      }
      // SQLite VACUUM INTO requires the target file to not exist prior to command
      fs.unlinkSync(resolvedDest);
    }

    const escapedDest = resolvedDest.replace(/'/g, "''");
    try {
      this.db.exec(`VACUUM INTO '${escapedDest}';`);
    } catch (err) {
      throw new Error(
        `BACKUP_EXECUTION_FAILED: VACUUM INTO failed for '${resolvedDest}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!fs.existsSync(resolvedDest)) {
      throw new Error(`BACKUP_VERIFICATION_FAILED: Backup file was not created at '${resolvedDest}'.`);
    }

    // Verify backup integrity by opening with an independent handle
    try {
      const verifyHandle = new DatabaseSync(resolvedDest);
      const verifyCheck = verifyHandle.prepare("PRAGMA quick_check;").get() as Record<string, unknown> | undefined;
      const verifyVal = String(verifyCheck?.quick_check ?? Object.values(verifyCheck || {})[0] ?? "");
      verifyHandle.close();

      if (verifyVal.toLowerCase() !== "ok") {
        throw new Error(`Backup file quick_check failed: ${verifyVal}`);
      }
    } catch (verifyErr) {
      throw new Error(
        `BACKUP_VERIFICATION_FAILED: Backup file at '${resolvedDest}' could not be verified: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`
      );
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
