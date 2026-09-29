// ============================================================================
// FILE: server/__tests__/testStorageHelper.ts
// MODULE: TEST-SCOPED STORAGE MECHANISM HARNESS (M18-C1)
// NOTE: For test suite execution only. Not part of production exports.
// ============================================================================

import { SqliteStorage, type Migration, type SqliteStorageConfig } from "../storage";

/**
 * Test subclass of SqliteStorage that allows unit testing SQLite mechanics
 * under local non-target Node versions without weakening production admission.
 */
export class TestSqliteStorage extends SqliteStorage {
  constructor(config: SqliteStorageConfig = {}) {
    super(config);
  }

  public openForTest(customMigrations?: readonly Migration[]): void {
    if (this.getStatus().isClosed) {
      throw new Error("STORAGE_CLOSED: Cannot open a closed storage instance.");
    }
    this.initializeStorage(customMigrations);
  }
}
