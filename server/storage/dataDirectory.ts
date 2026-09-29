// ============================================================================
// FILE: server/storage/dataDirectory.ts
// MODULE: PERSISTENT DATA DIRECTORY CONTRACT (M18-C1)
// NOTE: Single server-side persistent-data directory contract with fail-closed validation.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DATA_DIR_ENV_VAR = "QUANTFUND_DATA_DIR";
export const DEFAULT_DATA_DIR_NAME = "data";
export const DEFAULT_DB_FILENAME = "quantfund.db";

export interface DataDirValidationResult {
  readonly ok: boolean;
  readonly path: string;
  readonly error?: string;
}

export function getDefaultDataDirectory(): string {
  return path.resolve(process.cwd(), DEFAULT_DATA_DIR_NAME);
}

export function resolveDataDirectory(
  customDir?: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  if (customDir && customDir.trim().length > 0) {
    return path.resolve(customDir.trim());
  }

  const envDir = env[DATA_DIR_ENV_VAR];
  if (envDir && envDir.trim().length > 0) {
    return path.resolve(envDir.trim());
  }

  return getDefaultDataDirectory();
}

export function validateAndEnsureDataDirectory(dirPath: string): DataDirValidationResult {
  if (!dirPath || typeof dirPath !== "string" || dirPath.trim().length === 0) {
    return {
      ok: false,
      path: dirPath,
      error: "Data directory path must be a non-empty string.",
    };
  }

  const resolved = path.resolve(dirPath.trim());

  try {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        path: resolved,
        error: `Configured data path exists but is not a directory: '${resolved}'`,
      };
    }

    // Probe write/delete permissions deterministically
    const probeFile = path.join(resolved, `.write_probe_${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
      fs.writeFileSync(probeFile, "quantfund_probe", "utf8");
      fs.unlinkSync(probeFile);
    } catch (writeErr) {
      return {
        ok: false,
        path: resolved,
        error: `Data directory '${resolved}' is not writable: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
      };
    }

    return {
      ok: true,
      path: resolved,
    };
  } catch (err) {
    return {
      ok: false,
      path: resolved,
      error: `Failed to initialize persistent data directory '${resolved}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function assertDataDirectory(dirPath: string): string {
  const validation = validateAndEnsureDataDirectory(dirPath);
  if (!validation.ok) {
    throw new Error(
      `DATA_DIRECTORY_INVALID: Persistent storage cannot be initialized. ${validation.error}`
    );
  }
  return validation.path;
}

/**
 * Validates that databaseFilename is a clean filename without path separators or traversal.
 */
export function validateDatabaseFilename(filename?: string): { ok: boolean; filename: string; error?: string } {
  if (!filename || typeof filename !== "string" || filename.trim().length === 0) {
    return { ok: false, filename: filename ?? "", error: "Database filename must be a non-empty string." };
  }

  const trimmed = filename.trim();

  if (trimmed.includes("\0")) {
    return { ok: false, filename: trimmed, error: "Database filename must not contain null bytes." };
  }

  if (path.isAbsolute(trimmed)) {
    return { ok: false, filename: trimmed, error: `Database filename must not be an absolute path: '${trimmed}'` };
  }

  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return { ok: false, filename: trimmed, error: `Database filename must not contain path separators or directory traversal: '${trimmed}'` };
  }

  if (trimmed === "." || trimmed === "..") {
    return { ok: false, filename: trimmed, error: `Invalid database filename: '${trimmed}'` };
  }

  return { ok: true, filename: trimmed };
}

export function assertDatabaseFilename(filename?: string): string {
  const validation = validateDatabaseFilename(filename);
  if (!validation.ok) {
    throw new Error(`DATABASE_PATH_INVALID: ${validation.error}`);
  }
  return validation.filename;
}

/**
 * Safely resolves database path and verifies it is contained within the validated data directory.
 */
export function resolveDatabasePath(dataDir: string, filename?: string): string {
  const validatedDir = assertDataDirectory(dataDir);
  const targetFilename = filename && filename.trim().length > 0 ? filename.trim() : DEFAULT_DB_FILENAME;
  const validatedFile = validateDatabaseFilename(targetFilename);
  if (!validatedFile.ok) {
    throw new Error(`DATABASE_PATH_CONTAINMENT_FAILED: ${validatedFile.error}`);
  }

  const resolved = path.resolve(validatedDir, validatedFile.filename);
  const expectedPrefix = validatedDir.endsWith(path.sep) ? validatedDir : validatedDir + path.sep;

  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error(
      `DATABASE_PATH_CONTAINMENT_FAILED: Resolved database path '${resolved}' escapes data directory '${validatedDir}'.`
    );
  }

  return resolved;
}
