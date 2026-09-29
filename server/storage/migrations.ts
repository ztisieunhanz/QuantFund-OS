// ============================================================================
// FILE: server/storage/migrations.ts
// MODULE: DETERMINISTIC FORWARD-ONLY MIGRATIONS (M18-C1)
// NOTE: Content-bound migration infrastructure with exact C1 schema allowlist.
// ============================================================================

import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Migration, MigrationRecord } from "./types";

export const MIGRATIONS_TABLE = "_schema_migrations";
export const METADATA_TABLE = "_schema_metadata";

export const ALLOWED_C1_TABLES: readonly string[] = Object.freeze([
  METADATA_TABLE,
  MIGRATIONS_TABLE,
]);

export const FOUNDATION_BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS _schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT OR REPLACE INTO _schema_metadata (key, value, updated_at) VALUES ('schema_version', '1', 0);
INSERT OR REPLACE INTO _schema_metadata (key, value, updated_at) VALUES ('foundation_initialized_at', '0', 0);
INSERT OR REPLACE INTO _schema_metadata (key, value, updated_at) VALUES ('architecture_milestone', 'M18-C1', 0);
`.trim();

/**
 * Computes a deterministic SHA-256 digest from canonical migration material.
 */
export function computeMigrationChecksum(
  migration: Pick<Migration, "id" | "namespace" | "name" | "sql">
): string {
  const canonicalMaterial = [
    migration.id.trim(),
    migration.namespace.trim(),
    migration.name.trim(),
    migration.sql.trim(),
  ].join("\n---\n");

  const digest = crypto
    .createHash("sha256")
    .update(canonicalMaterial, "utf8")
    .digest("hex");

  return `sha256:${digest}`;
}

/**
 * Foundation Bootstrap Migration (001)
 * Establishes minimal schema metadata and storage infrastructure.
 * Strictly no controller or financial ledger tables. Pure checksum-bound SQL.
 */
export const FOUNDATION_BOOTSTRAP_MIGRATION: Migration = {
  id: "001_foundation_bootstrap",
  namespace: "foundation",
  name: "Establish Schema Metadata & Storage Infrastructure",
  sql: FOUNDATION_BOOTSTRAP_SQL,
  checksum: computeMigrationChecksum({
    id: "001_foundation_bootstrap",
    namespace: "foundation",
    name: "Establish Schema Metadata & Storage Infrastructure",
    sql: FOUNDATION_BOOTSTRAP_SQL,
  }),
};

export const REGISTERED_MIGRATIONS: readonly Migration[] = Object.freeze([
  FOUNDATION_BOOTSTRAP_MIGRATION,
]);

/**
 * Validates migration registry integrity before running any database actions.
 * Enforces canonical foundation prefix and transaction boundary constraints.
 */
export function validateMigrationRegistry(migrations: readonly Migration[]): void {
  if (!migrations || migrations.length === 0) {
    throw new Error("MIGRATION_REGISTRY_INVALID: FOUNDATION_PREFIX_VIOLATION: Migration registry must not be empty.");
  }

  // 1. Enforce canonical immutable foundation prefix
  const first = migrations[0];
  if (
    first.id !== FOUNDATION_BOOTSTRAP_MIGRATION.id ||
    first.namespace !== FOUNDATION_BOOTSTRAP_MIGRATION.namespace ||
    first.name !== FOUNDATION_BOOTSTRAP_MIGRATION.name ||
    first.sql.trim() !== FOUNDATION_BOOTSTRAP_MIGRATION.sql.trim()
  ) {
    throw new Error(
      `MIGRATION_REGISTRY_INVALID: FOUNDATION_PREFIX_VIOLATION: Initial migration must be canonical foundation bootstrap '${FOUNDATION_BOOTSTRAP_MIGRATION.id}'.`
    );
  }

  const seenIds = new Set<string>();
  const allowedNamespaces = new Set(["foundation", "ledger", "controller"]);

  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i];

    if (!m.id || typeof m.id !== "string" || m.id.trim().length === 0) {
      throw new Error(`MIGRATION_REGISTRY_INVALID: Migration at index ${i} has empty ID.`);
    }
    if (seenIds.has(m.id)) {
      throw new Error(`MIGRATION_REGISTRY_INVALID: DUPLICATE_MIGRATION_ID: Duplicate migration ID detected: '${m.id}'.`);
    }
    seenIds.add(m.id);

    if (!allowedNamespaces.has(m.namespace)) {
      throw new Error(
        `MIGRATION_REGISTRY_INVALID: Migration '${m.id}' has invalid namespace '${m.namespace}'.`
      );
    }

    if (!m.name || typeof m.name !== "string" || m.name.trim().length === 0) {
      throw new Error(`MIGRATION_REGISTRY_INVALID: Migration '${m.id}' has empty name.`);
    }

    if (!m.sql || typeof m.sql !== "string" || m.sql.trim().length === 0) {
      throw new Error(`MIGRATION_REGISTRY_INVALID: Migration '${m.id}' has empty SQL definition.`);
    }

    // Prohibit transaction-control statements that hijack runner boundaries
    const txMatch = m.sql.match(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i);
    if (txMatch) {
      throw new Error(
        `MIGRATION_REGISTRY_INVALID: UNAUTHORIZED_TRANSACTION_CONTROL: Migration '${m.id}' contains forbidden transaction control statement '${txMatch[0]}'.`
      );
    }

    if (i > 0) {
      const prevId = migrations[i - 1].id;
      if (m.id.localeCompare(prevId) <= 0) {
        throw new Error(
          `MIGRATION_REGISTRY_INVALID: INVALID_MIGRATION_ORDER: Migrations must be in strict ascending order. Found '${m.id}' after '${prevId}'.`
        );
      }
    }
  }
}

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
  validateMigrationRegistry(migrations);
  ensureMigrationHistoryTable(db);

  const appliedRecords = getAppliedMigrations(db);
  const registeredMap = new Map<string, Migration>(
    migrations.map((m) => [m.id, m])
  );

  // 1. Fail closed on unsupported future schema or checksum tampering
  for (const applied of appliedRecords) {
    const registered = registeredMap.get(applied.id);
    if (!registered) {
      throw new Error(
        `UNSUPPORTED_FUTURE_SCHEMA: Database contains migration '${applied.id}' from namespace '${applied.namespace}' not recognized by current runtime.`
      );
    }

    const expectedChecksum = computeMigrationChecksum(registered);
    if (
      applied.checksum !== expectedChecksum ||
      applied.namespace !== registered.namespace ||
      applied.name !== registered.name
    ) {
      throw new Error(
        `MIGRATION_CHECKSUM_MISMATCH: Applied migration '${applied.id}' does not match registered migration content. Expected checksum '${expectedChecksum}', got '${applied.checksum}'. Migration tampering detected.`
      );
    }
  }

  const appliedMap = new Map<string, MigrationRecord>(
    appliedRecords.map((rec) => [rec.id, rec])
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  // 2. Execute pending migrations in exact deterministic order
  for (const migration of migrations) {
    const existing = appliedMap.get(migration.id);

    if (existing) {
      skipped.push(migration.id);
      continue;
    }

    const checksum = computeMigrationChecksum(migration);

    // 3. Apply migration inside runner-owned immediate transaction
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(migration.sql);

      const recordStmt = db.prepare(`
        INSERT INTO ${MIGRATIONS_TABLE} (id, namespace, name, applied_at, checksum)
        VALUES (?, ?, ?, ?, ?)
      `);
      recordStmt.run(
        migration.id,
        migration.namespace,
        migration.name,
        Date.now(),
        checksum
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
 * Replaces denylist with an exact allowlist for C1 user-defined tables.
 */
export function verifyC1SchemaBoundaries(db: DatabaseSync): {
  valid: boolean;
  tables: string[];
  disallowedFound: string[];
} {
  const rows = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
  `).all() as unknown[];

  const tables = rows.map((r) => String((r as Record<string, unknown>).name));
  const allowedSet = new Set<string>(ALLOWED_C1_TABLES);
  const disallowedFound = tables.filter((tableName) => !allowedSet.has(tableName));

  return {
    valid: disallowedFound.length === 0,
    tables,
    disallowedFound,
  };
}
