// ============================================================================
// FILE: server/storage/migrations.ts
// MODULE: DETERMINISTIC FORWARD-ONLY MIGRATIONS (M18-C1)
// NOTE: Bootstrap migration infrastructure with fail-closed integrity.
// ============================================================================

import type { DatabaseSync } from "node:sqlite";
import type { Migration, MigrationRecord } from "./types";

export const MIGRATIONS_TABLE = "_schema_migrations";
export const METADATA_TABLE = "_schema_metadata";

/**
 * Foundation Bootstrap Migration (001)
 * Establishes only the minimal schema metadata and migration tracking.
 * Strictly no controller or financial ledger tables.
 */
export const FOUNDATION_BOOTSTRAP_MIGRATION: Migration = {
  id: "001_foundation_bootstrap",
  namespace: "foundation",
  name: "Establish Schema Metadata & Storage Infrastructure",
  checksum: "sha256:c1_foundation_bootstrap_20260929",
  up: (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    const now = Date.now();
    const insertMeta = db.prepare(`
      INSERT OR REPLACE INTO ${METADATA_TABLE} (key, value, updated_at)
      VALUES (?, ?, ?)
    `);

    insertMeta.run("schema_version", "1", now);
    insertMeta.run("foundation_initialized_at", String(now), now);
    insertMeta.run("architecture_milestone", "M18-C1", now);
  },
};

export const REGISTERED_MIGRATIONS: readonly Migration[] = Object.freeze([
  FOUNDATION_BOOTSTRAP_MIGRATION,
]);

export function ensureMigrationHistoryTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL
    );
  `);
}

export function getAppliedMigrations(db: DatabaseSync): MigrationRecord[] {
  ensureMigrationHistoryTable(db);
  const rows = db.prepare(`
    SELECT id, namespace, name, applied_at, checksum
    FROM ${MIGRATIONS_TABLE}
    ORDER BY id ASC
  `).all() as unknown[];

  return rows.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      namespace: String(r.namespace),
      name: String(r.name),
      applied_at: Number(r.applied_at),
      checksum: String(r.checksum),
    };
  });
}

export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = REGISTERED_MIGRATIONS
): { applied: string[]; skipped: string[] } {
  ensureMigrationHistoryTable(db);
  const appliedRecords = getAppliedMigrations(db);
  const appliedMap = new Map<string, MigrationRecord>(
    appliedRecords.map((rec) => [rec.id, rec])
  );

  const registeredIds = new Set(migrations.map((m) => m.id));

  // 1. Fail closed on unsupported future schema
  for (const applied of appliedRecords) {
    if (!registeredIds.has(applied.id)) {
      throw new Error(
        `UNSUPPORTED_FUTURE_SCHEMA: Database contains migration '${applied.id}' from namespace '${applied.namespace}' not recognized by current runtime.`
      );
    }
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  // 2. Execute migrations in exact deterministic order
  for (const migration of migrations) {
    const existing = appliedMap.get(migration.id);

    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `MIGRATION_CHECKSUM_MISMATCH: Applied migration '${migration.id}' has checksum '${existing.checksum}', expected '${migration.checksum}'. Migration tampering detected.`
        );
      }
      skipped.push(migration.id);
      continue;
    }

    // 3. Apply migration inside an immediate transaction
    db.exec("BEGIN IMMEDIATE;");
    try {
      migration.up(db);

      const recordStmt = db.prepare(`
        INSERT INTO ${MIGRATIONS_TABLE} (id, namespace, name, applied_at, checksum)
        VALUES (?, ?, ?, ?, ?)
      `);
      recordStmt.run(
        migration.id,
        migration.namespace,
        migration.name,
        Date.now(),
        migration.checksum
      );

      db.exec("COMMIT;");
      applied.push(migration.id);
    } catch (err) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // Rollback attempt
      }
      throw new Error(
        `MIGRATION_FAILED: Failed to apply migration '${migration.id}' (${migration.name}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { applied, skipped };
}

/**
 * Diagnostic utility to verify that only allowed C1 tables exist.
 * Rejects any presence of M18-D controller or financial ledger tables.
 */
export function verifyC1SchemaBoundaries(db: DatabaseSync): {
  valid: boolean;
  tables: string[];
  disallowedFound: string[];
} {
  const disallowedPatterns = [
    /^controller_/i,
    /^cycle_/i,
    /^cycle_commits$/i,
    /^fills$/i,
    /^ledger_/i,
    /^positions$/i,
    /^account_state$/i,
    /^owner_token$/i,
    /^heartbeat$/i,
  ];

  const rows = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all() as unknown[];

  const tables = rows.map((r) => String((r as Record<string, unknown>).name));
  const disallowedFound = tables.filter((tableName) =>
    disallowedPatterns.some((pattern) => pattern.test(tableName))
  );

  return {
    valid: disallowedFound.length === 0,
    tables,
    disallowedFound,
  };
}
