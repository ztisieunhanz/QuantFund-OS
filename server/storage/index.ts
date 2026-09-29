// ============================================================================
// FILE: server/storage/index.ts
// MODULE: STATEFUL NODE STORAGE MODULE ROOT (M18-C1)
// NOTE: Barrel export for storage foundation, types, migrations, and runtime checks.
// ============================================================================

export * from "./types";
export * from "./runtimeCompatibility";
export * from "./dataDirectory";
export * from "./migrations";
export * from "./sqliteStorage";
