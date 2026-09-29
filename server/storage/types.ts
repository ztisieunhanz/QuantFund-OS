// ============================================================================
// FILE: server/storage/types.ts
// MODULE: STATEFUL NODE SQLITE STORAGE TYPES (M18-C1)
// NOTE: Pure type definitions for storage, migrations, integrity, and backup.
// ============================================================================

import type { DatabaseSync } from "node:sqlite";

export interface SqliteStorageConfig {
  /** Root directory where database files are stored */
  readonly dataDir?: string;
  /** Primary database filename (default: 'quantfund.db') */
  readonly databaseFilename?: string;
  /** SQLite busy timeout in milliseconds (default: 5000) */
  readonly busyTimeoutMs?: number;
  /** Optional custom environment dictionary for resolving variables */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface StorageStatus {
  readonly isReady: boolean;
  readonly isClosed: boolean;
  readonly dbPath: string;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: boolean;
  readonly busyTimeoutMs: number;
  readonly appliedMigrationsCount: number;
  readonly lastMigrationId: string | null;
}

export interface Migration {
  readonly id: string;
  readonly namespace: "foundation" | "ledger" | "controller";
  readonly name: string;
  readonly checksum: string;
  readonly up: (db: DatabaseSync) => void;
}

export interface MigrationRecord {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly applied_at: number;
  readonly checksum: string;
}

export interface IntegrityCheckResult {
  readonly ok: boolean;
  readonly type: "quick" | "full";
  readonly details: readonly string[];
  readonly error?: string;
}

export interface BackupOptions {
  /** Target file destination path for online backup */
  readonly destinationPath: string;
  /** Whether to overwrite target if it already exists (default: false) */
  readonly overwrite?: boolean;
}

export interface BackupResult {
  readonly destinationPath: string;
  readonly bytesWritten: number;
  readonly completedAt: number;
}

export interface RuntimeCompatibilityResult {
  readonly compatible: boolean;
  readonly version: string;
  readonly supportedRange: string;
  readonly sqliteAvailable: boolean;
  readonly error?: string;
}
