// ============================================================================
// FILE: server/__tests__/sqliteStorage.test.ts
// MODULE: STATEFUL NODE SQLITE STORAGE FOUNDATION TESTS (M18-C1)
// NOTE: Isolated unit and integration tests proving runtime contracts,
//       pragmas, migrations, integrity, backups, and fail-closed safety.
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteStorage,
  checkNodeRuntimeCompatibility,
  isNodeVersionSupported,
  isNodeSqliteAvailable,
  resolveDataDirectory,
  validateAndEnsureDataDirectory,
  assertDataDirectory,
  runMigrations,
  getAppliedMigrations,
  verifyC1SchemaBoundaries,
  FOUNDATION_BOOTSTRAP_MIGRATION,
  type Migration,
} from "../storage";
import { createProductionServer, type ProductionServerInstance } from "../productionServer";
import http from "node:http";

function requestHttp(
  url: string,
  options: http.RequestOptions & { body?: string } = {}
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe("M18-C1: Stateful Node SQLite Foundation", () => {
  let tempBaseDir: string;
  let serverInstance: ProductionServerInstance | null = null;

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantfund-c1-test-"));
  });

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.close();
      serverInstance = null;
    }
    if (fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {
        // Temp cleanup
      }
    }
  });

  // --------------------------------------------------------------------------
  // 1. Supported Node Runtime Contract
  // --------------------------------------------------------------------------
  describe("1. Node Runtime Contract", () => {
    it("proves node:sqlite is available and functional in current runtime", () => {
      expect(isNodeSqliteAvailable()).toBe(true);
      const inMemoryDb = new DatabaseSync(":memory:");
      expect(typeof inMemoryDb.exec).toBe("function");
      inMemoryDb.close();
    });

    it("accepts supported Node versions >= 22.16.0 < 23", () => {
      expect(isNodeVersionSupported("22.16.0").supported).toBe(true);
      expect(isNodeVersionSupported("22.18.1").supported).toBe(true);
      expect(isNodeVersionSupported("22.23.3").supported).toBe(true);
      expect(isNodeVersionSupported("v22.23.3").supported).toBe(true);
    });

    it("rejects Node versions outside the architecture supported range", () => {
      // Below Node 22
      expect(isNodeVersionSupported("20.19.0").supported).toBe(false);
      expect(isNodeVersionSupported("21.7.0").supported).toBe(false);
      // Below 22.16.0
      expect(isNodeVersionSupported("22.12.0").supported).toBe(false);
      expect(isNodeVersionSupported("22.15.9").supported).toBe(false);
      // Above Node 22 line
      expect(isNodeVersionSupported("23.0.0").supported).toBe(false);
      expect(isNodeVersionSupported("24.0.0").supported).toBe(false);
    });

    it("evaluates runtime compatibility diagnostic truthfully", () => {
      const result = checkNodeRuntimeCompatibility("22.23.3");
      expect(result.compatible).toBe(true);
      expect(result.sqliteAvailable).toBe(true);
      expect(result.supportedRange).toBe(">=22.16.0 <23");

      const rejected = checkNodeRuntimeCompatibility("20.18.0");
      expect(rejected.compatible).toBe(false);
      expect(rejected.error).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 2. Persistent Data Directory Contract
  // --------------------------------------------------------------------------
  describe("2. Persistent Data Directory Contract", () => {
    it("resolves default data directory deterministically", () => {
      const defaultDir = resolveDataDirectory(undefined, {});
      expect(defaultDir).toBe(path.resolve(process.cwd(), "data"));
    });

    it("resolves configured environment variable QUANTFUND_DATA_DIR", () => {
      const customPath = path.join(tempBaseDir, "env-data");
      const resolved = resolveDataDirectory(undefined, { QUANTFUND_DATA_DIR: customPath });
      expect(resolved).toBe(path.resolve(customPath));
    });

    it("prefers explicitly provided customDir over environment variable", () => {
      const explicitPath = path.join(tempBaseDir, "explicit-data");
      const envPath = path.join(tempBaseDir, "env-data");
      const resolved = resolveDataDirectory(explicitPath, { QUANTFUND_DATA_DIR: envPath });
      expect(resolved).toBe(path.resolve(explicitPath));
    });

    it("validates and creates data directory safely", () => {
      const targetDir = path.join(tempBaseDir, "nested", "storage");
      const validation = validateAndEnsureDataDirectory(targetDir);
      expect(validation.ok).toBe(true);
      expect(fs.existsSync(targetDir)).toBe(true);
      expect(fs.statSync(targetDir).isDirectory()).toBe(true);
    });

    it("fails closed on invalid/empty data directory path", () => {
      const validation = validateAndEnsureDataDirectory("");
      expect(validation.ok).toBe(false);
      expect(validation.error).toContain("non-empty string");
      expect(() => assertDataDirectory("")).toThrow("DATA_DIRECTORY_INVALID");
    });
  });

  // --------------------------------------------------------------------------
  // 3. Database Lifecycle, Pragmas, and Verification
  // --------------------------------------------------------------------------
  describe("3. Database Lifecycle & Canonical Pragmas", () => {
    it("opens database in isolated temporary directory and verifies all canonical pragmas", () => {
      const storageDir = path.join(tempBaseDir, "db-test");
      const storage = new SqliteStorage({
        dataDir: storageDir,
        databaseFilename: "journal.db",
        busyTimeoutMs: 5000,
      });

      storage.open();
      const status = storage.getStatus();

      expect(status.isReady).toBe(true);
      expect(status.isClosed).toBe(false);
      expect(status.journalMode).toBe("wal");
      expect(status.synchronous).toBe(2); // 2 = FULL in SQLite
      expect(status.foreignKeys).toBe(true);
      expect(status.busyTimeoutMs).toBe(5000);
      expect(fs.existsSync(status.dbPath)).toBe(true);

      const db = storage.getDb();
      expect(db).toBeDefined();

      // Read back directly from SQLite to guarantee actual activation
      const jmRow = db.prepare("PRAGMA journal_mode;").get() as { journal_mode: string };
      expect(jmRow.journal_mode.toLowerCase()).toBe("wal");

      const syncRow = db.prepare("PRAGMA synchronous;").get() as { synchronous: number };
      expect(syncRow.synchronous).toBe(2);

      const fkRow = db.prepare("PRAGMA foreign_keys;").get() as { foreign_keys: number };
      expect(fkRow.foreign_keys).toBe(1);

      const btRow = db.prepare("PRAGMA busy_timeout;").get() as { timeout: number };
      expect(btRow.timeout).toBe(5000);

      storage.close();
    });

    it("enforces foreign key constraints at runtime", () => {
      const storageDir = path.join(tempBaseDir, "fk-test");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();
      const db = storage.getDb();

      db.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      `);

      // Attempt inserting child with nonexistent parent must fail
      expect(() => {
        db.prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)").run(1, 999);
      }).toThrow();

      // Valid parent insertion succeeds
      db.prepare("INSERT INTO parent (id, name) VALUES (?, ?)").run(10, "Parent Item");
      db.prepare("INSERT INTO child (id, parent_id) VALUES (?, ?)").run(1, 10);

      storage.close();
    });

    it("fails closed on invalid busy timeout (< 1000ms)", () => {
      const storageDir = path.join(tempBaseDir, "invalid-bt");
      const storage = new SqliteStorage({ dataDir: storageDir, busyTimeoutMs: 500 });
      expect(() => storage.open()).toThrow("busyTimeoutMs must be >= 1000ms");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Migration Infrastructure & Schema Boundaries
  // --------------------------------------------------------------------------
  describe("4. Migration Foundation & Schema Integrity", () => {
    it("applies bootstrap migration exactly once and records migration history deterministically", () => {
      const storageDir = path.join(tempBaseDir, "migration-test");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();

      const status = storage.getStatus();
      expect(status.appliedMigrationsCount).toBe(1);
      expect(status.lastMigrationId).toBe("001_foundation_bootstrap");

      const db = storage.getDb();
      const records = getAppliedMigrations(db);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe("001_foundation_bootstrap");
      expect(records[0].namespace).toBe("foundation");

      // Verify second open/run skips already applied migrations safely
      const secondRun = runMigrations(db);
      expect(secondRun.applied).toHaveLength(0);
      expect(secondRun.skipped).toContain("001_foundation_bootstrap");

      // Verify schema metadata table content
      const metaRow = db.prepare("SELECT value FROM _schema_metadata WHERE key = ?").get("schema_version") as { value: string };
      expect(metaRow.value).toBe("1");

      const milestoneRow = db.prepare("SELECT value FROM _schema_metadata WHERE key = ?").get("architecture_milestone") as { value: string };
      expect(milestoneRow.value).toBe("M18-C1");

      storage.close();
    });

    it("fails closed and rolls back cleanly when a migration throws an error", () => {
      const storageDir = path.join(tempBaseDir, "migration-fail");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();
      const db = storage.getDb();

      const failingMigration: Migration = {
        id: "002_broken_migration",
        namespace: "foundation",
        name: "Broken Migration",
        checksum: "sha256:broken",
        up: (dbSync) => {
          dbSync.exec("CREATE TABLE temporary_probe (id INT PRIMARY KEY);");
          throw new Error("Simulated migration SQL failure");
        },
      };

      expect(() => {
        runMigrations(db, [FOUNDATION_BOOTSTRAP_MIGRATION, failingMigration]);
      }).toThrow("MIGRATION_FAILED");

      // Verify failed migration was NOT recorded in _schema_migrations
      const applied = getAppliedMigrations(db);
      expect(applied.some((m) => m.id === "002_broken_migration")).toBe(false);

      // Verify transaction rollback did not leave the table
      const probeTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='temporary_probe'").get();
      expect(probeTable).toBeUndefined();

      storage.close();
    });

    it("fails closed on migration checksum tampering", () => {
      const storageDir = path.join(tempBaseDir, "migration-tamper");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();
      const db = storage.getDb();

      const tamperedMigration: Migration = {
        ...FOUNDATION_BOOTSTRAP_MIGRATION,
        checksum: "sha256:tampered_content_hash",
      };

      expect(() => {
        runMigrations(db, [tamperedMigration]);
      }).toThrow("MIGRATION_CHECKSUM_MISMATCH");

      storage.close();
    });

    it("fails closed when encountering unknown future schema migrations", () => {
      const storageDir = path.join(tempBaseDir, "migration-future");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();
      const db = storage.getDb();

      // Simulate a future migration recorded by a newer version
      db.prepare(`
        INSERT INTO _schema_migrations (id, namespace, name, applied_at, checksum)
        VALUES (?, ?, ?, ?, ?)
      `).run("099_future_feature", "controller", "Future Controller", Date.now(), "sha256:future");

      // Current runtime with only 001 registered must reject future DB fail-closed
      expect(() => {
        runMigrations(db, [FOUNDATION_BOOTSTRAP_MIGRATION]);
      }).toThrow("UNSUPPORTED_FUTURE_SCHEMA");

      storage.close();
    });

    it("strictly verifies no controller or financial ledger tables exist in C1", () => {
      const storageDir = path.join(tempBaseDir, "schema-boundary");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();
      const db = storage.getDb();

      const check = verifyC1SchemaBoundaries(db);
      expect(check.valid).toBe(true);
      expect(check.disallowedFound).toEqual([]);

      // Allowed tables in C1: strictly metadata and migrations
      expect(check.tables.sort()).toEqual(["_schema_metadata", "_schema_migrations"].sort());

      storage.close();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Integrity Check Primitives
  // --------------------------------------------------------------------------
  describe("5. Integrity Diagnostics", () => {
    it("runs quick integrity diagnostic successfully on healthy database", () => {
      const storageDir = path.join(tempBaseDir, "quick-integrity");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();

      const quick = storage.quickIntegrityCheck();
      expect(quick.ok).toBe(true);
      expect(quick.type).toBe("quick");
      expect(quick.details).toEqual(["ok"]);
      expect(quick.error).toBeUndefined();

      storage.close();
    });

    it("runs explicit full integrity diagnostic successfully", () => {
      const storageDir = path.join(tempBaseDir, "full-integrity");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();

      const full = storage.fullIntegrityCheck();
      expect(full.ok).toBe(true);
      expect(full.type).toBe("full");
      expect(full.details).toEqual(["ok"]);
      expect(full.error).toBeUndefined();

      storage.close();
    });

    it("returns error diagnostic when integrity checks are run on closed storage", () => {
      const storageDir = path.join(tempBaseDir, "closed-integrity");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();
      storage.close();

      const quick = storage.quickIntegrityCheck();
      expect(quick.ok).toBe(false);
      expect(quick.error).toContain("closed");

      const full = storage.fullIntegrityCheck();
      expect(full.ok).toBe(false);
      expect(full.error).toContain("closed");
    });
  });

  // --------------------------------------------------------------------------
  // 6. Online Backup Primitive
  // --------------------------------------------------------------------------
  describe("6. Online Backup Primitive", () => {
    it("performs online backup via node:sqlite backup API and verifies committed data", async () => {
      const storageDir = path.join(tempBaseDir, "backup-source");
      const backupDir = path.join(tempBaseDir, "backups");
      const backupFile = path.join(backupDir, "quantfund-backup.db");

      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();

      const result = await storage.backup({ destinationPath: backupFile });
      expect(result.destinationPath).toBe(path.resolve(backupFile));
      expect(result.bytesWritten).toBeGreaterThan(0);
      expect(fs.existsSync(backupFile)).toBe(true);

      // 1. Verify backup independently with an isolated DatabaseSync instance
      const backupDb = new DatabaseSync(backupFile);
      const appliedInBackup = getAppliedMigrations(backupDb);
      expect(appliedInBackup).toHaveLength(1);
      expect(appliedInBackup[0].id).toBe("001_foundation_bootstrap");

      const metaRow = backupDb.prepare("SELECT value FROM _schema_metadata WHERE key = ?").get("schema_version") as { value: string };
      expect(metaRow.value).toBe("1");

      // 2. Verify backup passes PRAGMA quick_check
      const quickCheck = backupDb.prepare("PRAGMA quick_check;").get() as Record<string, unknown>;
      const checkVal = String(quickCheck.quick_check ?? Object.values(quickCheck)[0] ?? "");
      expect(checkVal.toLowerCase()).toBe("ok");
      backupDb.close();

      // 3. Source DB remains canonical, open, and usable after backup
      const sourceDb = storage.getDb();
      const sourceMeta = sourceDb.prepare("SELECT value FROM _schema_metadata WHERE key = ?").get("schema_version") as { value: string };
      expect(sourceMeta.value).toBe("1");

      storage.close();
    });

    it("fails closed on existing backup file when overwrite is false and allows overwrite when true", async () => {
      const storageDir = path.join(tempBaseDir, "backup-no-overwrite");
      const backupFile = path.join(tempBaseDir, "existing-backup.db");

      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();

      await storage.backup({ destinationPath: backupFile });
      expect(fs.existsSync(backupFile)).toBe(true);

      // Second backup with overwrite: false must fail closed
      await expect(
        storage.backup({ destinationPath: backupFile, overwrite: false })
      ).rejects.toThrow("BACKUP_DESTINATION_EXISTS");

      // Second backup with overwrite: true succeeds
      await expect(
        storage.backup({ destinationPath: backupFile, overwrite: true })
      ).resolves.toMatchObject({ destinationPath: path.resolve(backupFile) });

      storage.close();
    });

    it("rejects backup on closed or unready storage", async () => {
      const storageDir = path.join(tempBaseDir, "backup-closed");
      const storage = new SqliteStorage({ dataDir: storageDir });
      await expect(
        storage.backup({ destinationPath: path.join(tempBaseDir, "bak.db") })
      ).rejects.toThrow("STORAGE_NOT_READY");
    });

    it("fails closed on empty or invalid backup destination path", async () => {
      const storageDir = path.join(tempBaseDir, "backup-invalid-path");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();

      await expect(
        storage.backup({ destinationPath: "" })
      ).rejects.toThrow("BACKUP_PATH_INVALID");

      storage.close();
    });
  });

  // --------------------------------------------------------------------------
  // 7. Graceful Close & Idempotency
  // --------------------------------------------------------------------------
  describe("7. Graceful Close Lifecycle", () => {
    it("closes database cleanly and makes repeated close calls safe and idempotent", () => {
      const storageDir = path.join(tempBaseDir, "graceful-close");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();

      expect(storage.getStatus().isReady).toBe(true);
      expect(storage.getStatus().isClosed).toBe(false);

      storage.close();
      expect(storage.getStatus().isReady).toBe(false);
      expect(storage.getStatus().isClosed).toBe(true);

      // Repeated close must be a safe no-op
      expect(() => storage.close()).not.toThrow();

      // Any subsequent query throws STORAGE_CLOSED
      expect(() => storage.getDb()).toThrow("STORAGE_CLOSED");
      expect(() => storage.open()).toThrow("STORAGE_CLOSED");
    });
  });

  // --------------------------------------------------------------------------
  // 8. Server Readiness & Health Distinction
  // --------------------------------------------------------------------------
  describe("8. Production Server Health vs Readiness Distinction", () => {
    it("distinguishes process alive (GET /api/health) from storage readiness (GET /api/ready)", async () => {
      const storageDir = path.join(tempBaseDir, "server-storage");
      const storage = new SqliteStorage({ dataDir: storageDir });
      storage.open();

      serverInstance = createProductionServer({
        storage,
        staticDir: path.join(tempBaseDir, "dist"),
      });
      const addr = await serverInstance.listen(0, "127.0.0.1");

      // 1. Health check (process alive)
      const healthRes = await requestHttp(`${addr.url}/api/health`, { method: "GET" });
      expect(healthRes.statusCode).toBe(200);
      const healthBody = JSON.parse(healthRes.body);
      expect(healthBody.status).toBe("ok");
      expect(typeof healthBody.uptime).toBe("number");

      // 2. Readiness check (storage ready)
      const readyRes = await requestHttp(`${addr.url}/api/ready`, { method: "GET" });
      expect(readyRes.statusCode).toBe(200);
      const readyBody = JSON.parse(readyRes.body);
      expect(readyBody.status).toBe("ready");
      expect(readyBody.storage.isReady).toBe(true);
      expect(readyBody.storage.journalMode).toBe("wal");

      // 3. Close storage to simulate degraded/closed storage
      storage.close();
      const degradedReadyRes = await requestHttp(`${addr.url}/api/ready`, { method: "GET" });
      expect(degradedReadyRes.statusCode).toBe(503);
      const degradedBody = JSON.parse(degradedReadyRes.body);
      expect(degradedBody.status).toBe("unready");
      expect(degradedBody.error.code).toBe("STORAGE_NOT_READY");

      // Health continues returning 200 (process is still alive)
      const healthStillOk = await requestHttp(`${addr.url}/api/health`, { method: "GET" });
      expect(healthStillOk.statusCode).toBe(200);
    });

    it("enforces GET-only for /api/ready and returns 405 for POST/HEAD", async () => {
      serverInstance = createProductionServer({
        staticDir: path.join(tempBaseDir, "dist"),
      });
      const addr = await serverInstance.listen(0, "127.0.0.1");

      const postRes = await requestHttp(`${addr.url}/api/ready`, { method: "POST" });
      expect(postRes.statusCode).toBe(405);
      expect(postRes.headers.allow).toBe("GET");
    });
  });
});
