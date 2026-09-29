// ============================================================================
// FILE: server/storage/runtimeCompatibility.ts
// MODULE: NODE RUNTIME COMPATIBILITY CONTRACT (M18-C1)
// NOTE: Validates node:sqlite availability and Node 22 architecture range (>=22.16.0 <23).
// ============================================================================

import type { RuntimeCompatibilityResult } from "./types";

export const SUPPORTED_NODE_RANGE = ">=22.16.0 <23";
export const EXACT_TESTED_NODE_PATCH = "22.23.3";
export const MIN_NODE_MAJOR = 22;
export const MAX_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 16;

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

export function parseSemver(versionStr: string): ParsedSemver | null {
  const cleaned = versionStr.trim().replace(/^v/i, "");
  const match = cleaned.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    raw: versionStr,
  };
}

export function isNodeVersionSupported(versionStr: string): { supported: boolean; reason?: string } {
  const parsed = parseSemver(versionStr);
  if (!parsed) {
    return { supported: false, reason: `Invalid semver string: ${versionStr}` };
  }

  if (parsed.major < MIN_NODE_MAJOR) {
    return {
      supported: false,
      reason: `Node major version ${parsed.major} is below minimum supported 22 (${SUPPORTED_NODE_RANGE}).`,
    };
  }

  if (parsed.major > MAX_NODE_MAJOR) {
    return {
      supported: false,
      reason: `Node major version ${parsed.major} is above supported Node 22 line (${SUPPORTED_NODE_RANGE}).`,
    };
  }

  if (parsed.minor < MIN_NODE_MINOR) {
    return {
      supported: false,
      reason: `Node version 22.${parsed.minor}.${parsed.patch} is below minimum required 22.16.0 with stable node:sqlite support.`,
    };
  }

  return { supported: true };
}

export function isNodeSqliteAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require("node:sqlite");
    return typeof sqlite?.DatabaseSync === "function";
  } catch {
    return false;
  }
}

export function checkNodeRuntimeCompatibility(
  customVersion?: string
): RuntimeCompatibilityResult {
  const currentVersion = customVersion ?? process.versions.node ?? process.version;
  const versionCheck = isNodeVersionSupported(currentVersion);
  const sqliteAvailable = isNodeSqliteAvailable();

  if (!versionCheck.supported) {
    return {
      compatible: false,
      version: currentVersion,
      supportedRange: SUPPORTED_NODE_RANGE,
      sqliteAvailable,
      error: versionCheck.reason,
    };
  }

  if (!sqliteAvailable) {
    return {
      compatible: false,
      version: currentVersion,
      supportedRange: SUPPORTED_NODE_RANGE,
      sqliteAvailable: false,
      error: "Built-in 'node:sqlite' DatabaseSync is not available in current Node runtime environment.",
    };
  }

  return {
    compatible: true,
    version: currentVersion,
    supportedRange: SUPPORTED_NODE_RANGE,
    sqliteAvailable: true,
  };
}

export function assertNodeRuntimeCompatibility(customVersion?: string): void {
  const currentVersion = customVersion ?? process.versions.node ?? process.version;
  const result = checkNodeRuntimeCompatibility(currentVersion);

  if (!result.compatible) {
    throw new Error(
      `RUNTIME_INCOMPATIBLE: Node.js runtime '${currentVersion}' does not satisfy architecture contract (${SUPPORTED_NODE_RANGE}). ${result.error ?? ""}`
    );
  }
}
