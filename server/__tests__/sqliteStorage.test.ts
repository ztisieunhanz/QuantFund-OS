// ============================================================================
// FILE: server/__tests__/sqliteStorage.test.ts
// MODULE: STATEFUL NODE SQLITE STORAGE FOUNDATION TESTS (M18-C1)
// NOTE: Isolated unit and integration tests proving runtime contracts,
//       pragmas, migrations, integrity, backups, and fail-closed safety.
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SqliteStorage,
  checkNodeRuntimeCompatibility,
  isNodeVersionSupported,
  isNodeSqliteAvailable,
  assertNodeRuntimeCompatibility,
  resolveDataDirectory,
  validateAndEnsureDataDirectory,
  assertDataDirectory,
  validateDatabaseFilename,
  assertDatabaseFilename,
  resolveDatabasePath,
  computeMigrationChecksum,
  validateMigrationRegistry,
  checkForForbiddenTransactionControl,
  runMigrations,
  getAppliedMigrations,
  verifyC1SchemaBoundaries,
  FOUNDATION_BOOTSTRAP_MIGRATION,
  MIN_BUSY_TIMEOUT_MS,
  MAX_BUSY_TIMEOUT_MS,
  type SqliteStorageConfig,
  type Migration,
} from "../storage";
import {
  createProductionServer,
  type ProductionServerInstance,
} from "../productionServer";
import { TestSqliteStorage } from "./testStorageHelper";
import { createTestProductionServer } from "./testServerHelper";

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

function createTestStorage(config: SqliteStorageConfig = {}): TestSqliteStorage {
  return new TestSqliteStorage(config);
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
  // 1. Supported Node Runtime Contract (P1-A)
  // --------------------------------------------------------------------------
  describe("1. Node Runtime Contract (P1-A)", () => {
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
      expect(isNodeVersionSupported("24.19.0").supported).toBe(false);
    });

    it("evaluates runtime compatibility diagnostic truthfully", () => {
      const result = checkNodeRuntimeCompatibility("22.23.3");
      expect(result.compatible).toBe(true);
      expect(result.sqliteAvailable).toBe(true);
      expect(result.supportedRange).toBe(">=22.16.0 <23");

      const rejected = checkNodeRuntimeCompatibility("20.18.0");
      expect(rejected.compatible).toBe(false);
      expect(rejected.error).toBeDefined();

      const rejected24 = checkNodeRuntimeCompatibility("24.19.0");
      expect(rejected24.compatible).toBe(false);
      expect(rejected24.error).toContain("Node major version 24 is above supported");
    });

    it("assertNodeRuntimeCompatibility evaluates real process runtime and rejects unsupported local runtime without spoofing", () => {
      // Current test runner process is Node 24, which must fail closed
      expect(() => assertNodeRuntimeCompatibility()).toThrow("RUNTIME_INCOMPATIBLE");
    });

    it("enforces runtime compatibility in SqliteStorage.open() and createProductionServer() without bypasses", () => {
      const storageDir = path.join(tempBaseDir, "runtime-storage-test");
      const storage = new SqliteStorage({ dataDir: storageDir });

      // Verify no openDirect method exists on exported SqliteStorage prototype
      expect((storage as unknown as Record<string, unknown>).openDirect).toBeUndefined();

      // Production open() uses actual process.versions.node and throws RUNTIME_INCOMPATIBLE
      expect(() => storage.open()).toThrow("RUNTIME_INCOMPATIBLE");

      // Production server creation uses actual process.versions.node and throws RUNTIME_INCOMPATIBLE
      expect(() => createProductionServer()).toThrow("RUNTIME_INCOMPATIBLE");
    });
  });

  // --------------------------------------------------------------------------
  // 2. Persistent Data Directory & Path Containment Contract
  // --------------------------------------------------------------------------
  describe("2. Persistent Data Directory & Path Containment Contract", () => {
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

    it("strictly validates database filename to prevent path traversal or escape", () => {
      expect(assertDatabaseFilename("quantfund.db")).toBe("quantfund.db");
      expect(assertDatabaseFilename("custom_name-1.sqlite")).toBe("custom_name-1.sqlite");

      expect(validateDatabaseFilename("valid.db").ok).toBe(true);
      expect(validateDatabaseFilename("").ok).toBe(false);

      // Traversal rejection
      expect(() => assertDatabaseFilename("../escape.db")).toThrow("DATABASE_PATH_INVALID");
      expect(() => assertDatabaseFilename("..\\escape.db")).toThrow("DATABASE_PATH_INVALID");
      expect(() => assertDatabaseFilename("nested/quantfund.db")).toThrow("DATABASE_PATH_INVALID");
      expect(() => assertDatabaseFilename("nested\\quantfund.db")).toThrow("DATABASE_PATH_INVALID");
      expect(() => assertDatabaseFilename("C:\\absolute\\path.db")).toThrow("DATABASE_PATH_INVALID");
      expect(() => assertDatabaseFilename("/etc/passwd")).toThrow("DATABASE_PATH_INVALID");
      expect(() => assertDatabaseFilename("")).toThrow("DATABASE_PATH_INVALID");
    });

    it("resolves database path strictly contained in data directory", () => {
      const baseDir = path.resolve(tempBaseDir, "data");
      const resolved = resolveDatabasePath(baseDir, "test.db");
      expect(resolved).toBe(path.join(baseDir, "test.db"));

      // Default filename resolution
      const defaultResolved = resolveDatabasePath(baseDir);
      expect(defaultResolved).toBe(path.join(baseDir, "quantfund.db"));
    });
  });

  // --------------------------------------------------------------------------
  // 3. Database Lifecycle, Pragmas, and Verification
  // --------------------------------------------------------------------------
  describe("3. Database Lifecycle & Canonical Pragmas", () => {
    it("opens database via test harness and verifies all canonical pragmas", () => {
      const storageDir = path.join(tempBaseDir, "db-test");
      const storage = createTestStorage({
        dataDir: storageDir,
        databaseFilename: "journal.db",
        busyTimeoutMs: 5000,
      });

      storage.openForTest();
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
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();
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

    it("strictly bounds busy timeout to valid integers within [1000..60000] ms", () => {
      const storageDir = path.join(tempBaseDir, "bt-bounds");

      // Too low (< 1000)
      const lowStorage = createTestStorage({ dataDir: storageDir, busyTimeoutMs: 500 });
      expect(() => lowStorage.openForTest()).toThrow("busyTimeoutMs must be an integer between 1000 and 60000");

      // Too high (> 60000)
      const highStorage = createTestStorage({ dataDir: storageDir, busyTimeoutMs: 70000 });
      expect(() => highStorage.openForTest()).toThrow("busyTimeoutMs must be an integer between 1000 and 60000");

      // Fractional
      const fracStorage = createTestStorage({ dataDir: storageDir, busyTimeoutMs: 2500.5 });
      expect(() => fracStorage.openForTest()).toThrow("busyTimeoutMs must be an integer between 1000 and 60000");

      // Valid boundaries
      const minStorage = createTestStorage({ dataDir: path.join(tempBaseDir, "bt-min"), busyTimeoutMs: MIN_BUSY_TIMEOUT_MS });
      minStorage.openForTest();
      expect(minStorage.getStatus().busyTimeoutMs).toBe(MIN_BUSY_TIMEOUT_MS);
      minStorage.close();

      const maxStorage = createTestStorage({ dataDir: path.join(tempBaseDir, "bt-max"), busyTimeoutMs: MAX_BUSY_TIMEOUT_MS });
      maxStorage.openForTest();
      expect(maxStorage.getStatus().busyTimeoutMs).toBe(MAX_BUSY_TIMEOUT_MS);
      maxStorage.close();
    });

    it("cleans up database handle and state deterministically on failed initialization", () => {
      const storageDir = path.join(tempBaseDir, "failed-init");
      const storage = createTestStorage({
        dataDir: storageDir,
        busyTimeoutMs: 500, // intentional config failure during openForTest()
      });

      expect(() => storage.openForTest()).toThrow("INVALID_CONFIG");

      // Verify internal handle was cleaned and nulled
      expect(storage.getStatus().isReady).toBe(false);
      expect(() => storage.getDb()).toThrow("STORAGE_NOT_READY");
    });
  });

  // --------------------------------------------------------------------------
  // 4. Migration Infrastructure & Schema Boundaries (P1-B & P1-C)
  // --------------------------------------------------------------------------
  describe("4. Migration Foundation & Schema Integrity (P1-B & P1-C)", () => {
    it("computes deterministic SHA-256 digest from canonical migration material", () => {
      const digest1 = computeMigrationChecksum(FOUNDATION_BOOTSTRAP_MIGRATION);
      const digest2 = computeMigrationChecksum(FOUNDATION_BOOTSTRAP_MIGRATION);
      expect(digest1).toBe(digest2);
      expect(digest1).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(FOUNDATION_BOOTSTRAP_MIGRATION.checksum).toBe(digest1);
    });

    it("prevalidates migration registry ordering and uniqueness", () => {
      expect(() => validateMigrationRegistry([FOUNDATION_BOOTSTRAP_MIGRATION])).not.toThrow();

      // Duplicate ID
      const dup: Migration = { ...FOUNDATION_BOOTSTRAP_MIGRATION };
      expect(() => validateMigrationRegistry([FOUNDATION_BOOTSTRAP_MIGRATION, dup])).toThrow("DUPLICATE_MIGRATION_ID");

      // Unsorted order after canonical foundation prefix
      const migration2: Migration = {
        id: "002_second",
        namespace: "foundation",
        name: "Second",
        checksum: "",
        sql: "CREATE TABLE test_table_b (id INT);",
      };
      migration2.checksum = computeMigrationChecksum(migration2);

      const migration3: Migration = {
        id: "003_third",
        namespace: "foundation",
        name: "Third",
        checksum: "",
        sql: "CREATE TABLE test_table_c (id INT);",
      };
      migration3.checksum = computeMigrationChecksum(migration3);

      expect(() => validateMigrationRegistry([FOUNDATION_BOOTSTRAP_MIGRATION, migration3, migration2])).toThrow("INVALID_MIGRATION_ORDER");
    });

    it("enforces canonical foundation prefix: missing or replaced foundation migration fails before mutation", () => {
      // 1. Empty registry
      expect(() => validateMigrationRegistry([])).toThrow("FOUNDATION_PREFIX_VIOLATION");

      // 2. Replaced ID
      const badId: Migration = {
        id: "001_other_bootstrap",
        namespace: "foundation",
        name: "Foundation Bootstrap",
        checksum: "",
        sql: FOUNDATION_BOOTSTRAP_MIGRATION.sql,
      };
      badId.checksum = computeMigrationChecksum(badId);
      expect(() => validateMigrationRegistry([badId])).toThrow("FOUNDATION_PREFIX_VIOLATION");

      // 3. Replaced Namespace
      const badNamespace: Migration = {
        id: "001_foundation_bootstrap",
        namespace: "controller",
        name: "Foundation Bootstrap",
        checksum: "",
        sql: FOUNDATION_BOOTSTRAP_MIGRATION.sql,
      };
      badNamespace.checksum = computeMigrationChecksum(badNamespace);
      expect(() => validateMigrationRegistry([badNamespace])).toThrow("FOUNDATION_PREFIX_VIOLATION");

      // 4. Replaced Name
      const badName: Migration = {
        id: "001_foundation_bootstrap",
        namespace: "foundation",
        name: "Fake Name",
        checksum: "",
        sql: FOUNDATION_BOOTSTRAP_MIGRATION.sql,
      };
      badName.checksum = computeMigrationChecksum(badName);
      expect(() => validateMigrationRegistry([badName])).toThrow("FOUNDATION_PREFIX_VIOLATION");

      // 5. Replaced SQL Content
      const badSql: Migration = {
        id: "001_foundation_bootstrap",
        namespace: "foundation",
        name: "Foundation Bootstrap",
        checksum: "",
        sql: "CREATE TABLE fake_table (id INT);",
      };
      badSql.checksum = computeMigrationChecksum(badSql);
      expect(() => validateMigrationRegistry([badSql])).toThrow("FOUNDATION_PREFIX_VIOLATION");
    });

    it("prohibits all transaction control statements (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE) (P1-B)", () => {
      const testStatements = [
        "BEGIN",
        "BEGIN TRANSACTION",
        "BEGIN DEFERRED",
        "BEGIN IMMEDIATE",
        "BEGIN EXCLUSIVE",
        "COMMIT",
        "COMMIT TRANSACTION",
        "END",
        "END TRANSACTION",
        "ROLLBACK",
        "ROLLBACK TRANSACTION",
        "ROLLBACK TO sp1",
        "ROLLBACK TO SAVEPOINT sp1",
        "SAVEPOINT sp1",
        "RELEASE sp1",
        "RELEASE SAVEPOINT sp1",
      ];

      for (const stmt of testStatements) {
        const txMigration: Migration = {
          id: "002_tx_tamper",
          namespace: "foundation",
          name: "Tx Tamper",
          checksum: "",
          sql: `CREATE TABLE temp_tbl (id INT); ${stmt};`,
        };
        txMigration.checksum = computeMigrationChecksum(txMigration);

        expect(() => validateMigrationRegistry([FOUNDATION_BOOTSTRAP_MIGRATION, txMigration])).toThrow(
          "UNAUTHORIZED_TRANSACTION_CONTROL"
        );
      }
    });

    it("permits harmless keywords inside string literals and comments without false positives (P1-B)", () => {
      const harmlessSql = `
        -- NOTE: This comment mentions BEGIN, COMMIT, END, ROLLBACK, and RELEASE safely
        /* Block comment with SAVEPOINT and END TRANSACTION */
        CREATE TABLE safe_table (
          id INT PRIMARY KEY,
          status TEXT DEFAULT 'THE END IS NEAR',
          action TEXT DEFAULT 'COMMIT_ACTION'
        );
      `;

      const check = checkForForbiddenTransactionControl(harmlessSql);
      expect(check.forbidden).toBe(false);

      const harmlessMigration: Migration = {
        id: "002_harmless",
        namespace: "foundation",
        name: "Harmless Keywords",
        checksum: "",
        sql: harmlessSql,
      };
      harmlessMigration.checksum = computeMigrationChecksum(harmlessMigration);

      expect(() => validateMigrationRegistry([FOUNDATION_BOOTSTRAP_MIGRATION, harmlessMigration])).not.toThrow();
    });

    it("CRITICAL REGRESSION: rejects END TRANSACTION takeover attempt before DB execution, preserves transaction ownership and safe reopen (P1-B)", () => {
      const storageDir = path.join(tempBaseDir, "migration-end-tx-regression");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();
      const db = storage.getDb();

      // Migration attempting early transaction termination with END TRANSACTION;
      const takeoverMigration: Migration = {
        id: "002_takeover_end_tx",
        namespace: "foundation",
        name: "Takeover Migration",
        checksum: "",
        sql: "CREATE TABLE unauthorized_tbl (id INT PRIMARY KEY); END TRANSACTION; INSERT INTO unauthorized_tbl VALUES (1);",
      };
      takeoverMigration.checksum = computeMigrationChecksum(takeoverMigration);

      // 1. Must fail before any execution in runMigrations
      expect(() => {
        runMigrations(db, [FOUNDATION_BOOTSTRAP_MIGRATION, takeoverMigration]);
      }).toThrow("UNAUTHORIZED_TRANSACTION_CONTROL");

      // 2. Verify no schema mutation from takeover persisted
      const probeTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='unauthorized_tbl'").get();
      expect(probeTable).toBeUndefined();

      // 3. Verify migration was NOT recorded in history
      const applied = getAppliedMigrations(db);
      expect(applied.some((m) => m.id === "002_takeover_end_tx")).toBe(false);

      // 4. Verify runner transaction state remains intact
      storage.close();

      // 5. Verify database reopens safely and cleanly
      const reopenStorage = createTestStorage({ dataDir: storageDir });
      expect(() => reopenStorage.openForTest()).not.toThrow();
      expect(reopenStorage.getStatus().isReady).toBe(true);
      expect(reopenStorage.getStatus().appliedMigrationsCount).toBe(1);
      reopenStorage.close();
    });

    it("applies bootstrap migration exactly once and records migration history deterministically", () => {
      const storageDir = path.join(tempBaseDir, "migration-test");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

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

    it("fails closed on modified migration content (content-bound checksum mismatch)", () => {
      const storageDir = path.join(tempBaseDir, "migration-tamper-content");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();
      const db = storage.getDb();

      // Tamper stored record
      db.prepare("UPDATE _schema_migrations SET checksum = 'sha256:corrupted' WHERE id = '001_foundation_bootstrap'").run();

      expect(() => {
        runMigrations(db, [FOUNDATION_BOOTSTRAP_MIGRATION]);
      }).toThrow("MIGRATION_CHECKSUM_MISMATCH");

      storage.close();
    });

    it("fails closed and rolls back cleanly when a migration throws an error", () => {
      const storageDir = path.join(tempBaseDir, "migration-fail");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();
      const db = storage.getDb();

      const failingMigration: Migration = {
        id: "002_broken_migration",
        namespace: "foundation",
        name: "Broken Migration",
        checksum: "",
        sql: "CREATE TABLE temporary_probe (id INT PRIMARY KEY); INVALID_SQL_SYNTAX;",
      };
      failingMigration.checksum = computeMigrationChecksum(failingMigration);

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

    it("fails closed when encountering unknown future schema migrations", () => {
      const storageDir = path.join(tempBaseDir, "migration-future");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();
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

    it("strictly verifies exact C1 schema allowlist and rejects unexpected tables like 'orders'", () => {
      const storageDir = path.join(tempBaseDir, "schema-boundary");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();
      const db = storage.getDb();

      const check = verifyC1SchemaBoundaries(db);
      expect(check.valid).toBe(true);
      expect(check.disallowedFound).toEqual([]);
      expect(check.tables.sort()).toEqual(["_schema_metadata", "_schema_migrations"].sort());

      // Create an unauthorized future financial table
      db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, amount REAL);");

      const checkAfterViolation = verifyC1SchemaBoundaries(db);
      expect(checkAfterViolation.valid).toBe(false);
      expect(checkAfterViolation.disallowedFound).toContain("orders");

      storage.close();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Integrity Diagnostics
  // --------------------------------------------------------------------------
  describe("5. Integrity Diagnostics", () => {
    it("runs quick integrity diagnostic successfully on healthy database", () => {
      const storageDir = path.join(tempBaseDir, "quick-integrity");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      const quick = storage.quickIntegrityCheck();
      expect(quick.ok).toBe(true);
      expect(quick.type).toBe("quick");
      expect(quick.details).toEqual(["ok"]);
      expect(quick.error).toBeUndefined();

      storage.close();
    });

    it("runs explicit full integrity diagnostic successfully", () => {
      const storageDir = path.join(tempBaseDir, "full-integrity");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      const full = storage.fullIntegrityCheck();
      expect(full.ok).toBe(true);
      expect(full.type).toBe("full");
      expect(full.details).toEqual(["ok"]);
      expect(full.error).toBeUndefined();

      storage.close();
    });

    it("returns error diagnostic when integrity checks are run on closed storage", () => {
      const storageDir = path.join(tempBaseDir, "closed-integrity");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();
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
  // 6. Online Backup Primitive & Failure-Safe Replacement (P1-B from previous review)
  // --------------------------------------------------------------------------
  describe("6. Online Backup Primitive & Failure-Safe Replacement", () => {
    it("performs online backup and verifies committed foundation data", async () => {
      const storageDir = path.join(tempBaseDir, "backup-source");
      const backupDir = path.join(tempBaseDir, "backups");
      const backupFile = path.join(backupDir, "quantfund-backup.db");

      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

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

    it("rejects backup when source equals destination (path identity protection)", async () => {
      const storageDir = path.join(tempBaseDir, "backup-identity");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      const sourceDbPath = storage.getStatus().dbPath;
      await expect(
        storage.backup({ destinationPath: sourceDbPath })
      ).rejects.toThrow("BACKUP_SOURCE_EQUALS_DESTINATION");

      // Source database remains usable
      expect(storage.getStatus().isReady).toBe(true);
      expect(storage.quickIntegrityCheck().ok).toBe(true);

      storage.close();
    });

    it("rejects backup when destination is a hardlink alias to the source database", async () => {
      const storageDir = path.join(tempBaseDir, "backup-hardlink-source");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      const sourceDbPath = storage.getStatus().dbPath;
      const hardlinkPath = path.join(tempBaseDir, "source-hardlink.db");

      try {
        fs.linkSync(sourceDbPath, hardlinkPath);
      } catch {
        // If filesystem does not support hard links, skip gracefully
        storage.close();
        return;
      }

      await expect(
        storage.backup({ destinationPath: hardlinkPath, overwrite: true })
      ).rejects.toThrow("BACKUP_SOURCE_EQUALS_DESTINATION");

      if (fs.existsSync(hardlinkPath)) {
        fs.unlinkSync(hardlinkPath);
      }
      storage.close();
    });

    it("rejects backup when destination is a symlink alias to the source database", async () => {
      const storageDir = path.join(tempBaseDir, "backup-symlink-source");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      const sourceDbPath = storage.getStatus().dbPath;
      const symlinkPath = path.join(tempBaseDir, "source-symlink.db");

      try {
        fs.symlinkSync(sourceDbPath, symlinkPath, "file");
      } catch {
        // If OS permissions prevent symlink creation, skip gracefully
        storage.close();
        return;
      }

      await expect(
        storage.backup({ destinationPath: symlinkPath, overwrite: true })
      ).rejects.toThrow("BACKUP_SOURCE_EQUALS_DESTINATION");

      if (fs.existsSync(symlinkPath)) {
        fs.unlinkSync(symlinkPath);
      }
      storage.close();
    });

    it("fails closed on existing backup file when overwrite is false and preserves existing file untouched", async () => {
      const storageDir = path.join(tempBaseDir, "backup-no-overwrite");
      const backupFile = path.join(tempBaseDir, "existing-backup.db");

      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      await storage.backup({ destinationPath: backupFile });
      expect(fs.existsSync(backupFile)).toBe(true);
      const originalMtime = fs.statSync(backupFile).mtimeMs;
      const originalSize = fs.statSync(backupFile).size;

      // Second backup with overwrite: false must fail closed without touching existing file
      await expect(
        storage.backup({ destinationPath: backupFile, overwrite: false })
      ).rejects.toThrow("BACKUP_DESTINATION_EXISTS");

      expect(fs.statSync(backupFile).mtimeMs).toBe(originalMtime);
      expect(fs.statSync(backupFile).size).toBe(originalSize);

      storage.close();
    });

    it("preserves and restores old destination backup if promotion fails during overwrite", async () => {
      const storageDir = path.join(tempBaseDir, "backup-overwrite-restore");
      const backupFile = path.join(tempBaseDir, "preserve-me.db");

      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      // Write initial known-good backup
      await storage.backup({ destinationPath: backupFile });
      const originalContent = fs.readFileSync(backupFile);

      // Spy on fs.renameSync to simulate failure during promotion of temp to destination
      const originalRename = fs.renameSync;
      let renameCallCount = 0;
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
        renameCallCount++;
        // 1st rename: moves old destination to recovery path -> allow
        if (renameCallCount === 1) {
          return originalRename(oldPath, newPath);
        }
        // 2nd rename: promotes temp backup to destination -> force failure!
        if (renameCallCount === 2) {
          throw new Error("INJECTED_PROMOTION_FAILURE");
        }
        // 3rd rename: restores recovery path to destination -> allow
        return originalRename(oldPath, newPath);
      });

      try {
        await expect(
          storage.backup({ destinationPath: backupFile, overwrite: true })
        ).rejects.toThrow("BACKUP_PROMOTION_FAILED");

        // Verify original backup was restored and intact
        expect(fs.existsSync(backupFile)).toBe(true);
        const restoredContent = fs.readFileSync(backupFile);
        expect(restoredContent.equals(originalContent)).toBe(true);
      } finally {
        renameSpy.mockRestore();
      }

      storage.close();
    });

    it("preserves recovery backup artifact if restoration itself encounters a failure", async () => {
      const storageDir = path.join(tempBaseDir, "backup-recovery-preservation");
      const backupFile = path.join(tempBaseDir, "valuable-backup.db");

      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      await storage.backup({ destinationPath: backupFile });
      const originalContent = fs.readFileSync(backupFile);

      // Force promotion AND restoration failure
      const originalRename = fs.renameSync;
      let renameCallCount = 0;
      let capturedRecoveryPath = "";
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
        renameCallCount++;
        if (renameCallCount === 1) {
          capturedRecoveryPath = String(newPath);
          return originalRename(oldPath, newPath);
        }
        // 2nd and 3rd fail
        throw new Error("INJECTED_FILESYSTEM_FAILURE");
      });

      try {
        await expect(
          storage.backup({ destinationPath: backupFile, overwrite: true })
        ).rejects.toThrow(/BACKUP_PROMOTION_FAILED.*Original backup preserved at/);

        // Verify recovery copy exists with identical original bytes
        expect(capturedRecoveryPath).toBeTruthy();
        expect(fs.existsSync(capturedRecoveryPath)).toBe(true);
        const recoveryContent = fs.readFileSync(capturedRecoveryPath);
        expect(recoveryContent.equals(originalContent)).toBe(true);
      } finally {
        renameSpy.mockRestore();
      }

      storage.close();
    });

    it("successful overwrite cleans up recovery backup artifact", async () => {
      const storageDir = path.join(tempBaseDir, "backup-clean-recovery");
      const backupFile = path.join(tempBaseDir, "clean-target.db");

      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      await storage.backup({ destinationPath: backupFile });
      expect(fs.existsSync(backupFile)).toBe(true);

      // Second backup with overwrite: true succeeds
      const res = await storage.backup({ destinationPath: backupFile, overwrite: true });
      expect(res.destinationPath).toBe(path.resolve(backupFile));

      // No leftover .recovery_backup_* or .tmp_backup_* files in directory
      const files = fs.readdirSync(tempBaseDir);
      expect(files.filter((f) => f.startsWith(".recovery_backup_"))).toHaveLength(0);
      expect(files.filter((f) => f.startsWith(".tmp_backup_"))).toHaveLength(0);

      storage.close();
    });

    it("rejects backup on closed or unready storage", async () => {
      const storageDir = path.join(tempBaseDir, "backup-closed");
      const storage = createTestStorage({ dataDir: storageDir });
      await expect(
        storage.backup({ destinationPath: path.join(tempBaseDir, "bak.db") })
      ).rejects.toThrow("STORAGE_NOT_READY");
    });

    it("fails closed on empty or invalid backup destination path", async () => {
      const storageDir = path.join(tempBaseDir, "backup-invalid-path");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

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
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

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
  // 8. Server Readiness & Health Distinction (P1-D)
  // --------------------------------------------------------------------------
  describe("8. Production Server Health vs Readiness Distinction (P1-D)", () => {
    it("distinguishes process alive (GET /api/health) from storage readiness (GET /api/ready)", async () => {
      const storageDir = path.join(tempBaseDir, "server-storage");
      const storage = createTestStorage({ dataDir: storageDir });
      storage.openForTest();

      serverInstance = createTestProductionServer({
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

    it("returns HTTP 503 unready for /api/ready when storage is unconfigured", async () => {
      serverInstance = createTestProductionServer({
        staticDir: path.join(tempBaseDir, "dist"),
      });
      const addr = await serverInstance.listen(0, "127.0.0.1");

      const readyRes = await requestHttp(`${addr.url}/api/ready`, { method: "GET" });
      expect(readyRes.statusCode).toBe(503);
      const readyBody = JSON.parse(readyRes.body);
      expect(readyBody.status).toBe("unready");
      expect(readyBody.error.code).toBe("STORAGE_NOT_CONFIGURED");
      expect(readyBody.storage.ready).toBe(false);
    });

    it("enforces GET-only for /api/ready and returns 405 for POST/HEAD", async () => {
      serverInstance = createTestProductionServer({
        staticDir: path.join(tempBaseDir, "dist"),
      });
      const addr = await serverInstance.listen(0, "127.0.0.1");

      const postRes = await requestHttp(`${addr.url}/api/ready`, { method: "POST" });
      expect(postRes.statusCode).toBe(405);
      expect(postRes.headers.allow).toBe("GET");
    });
  });
});
