import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

export const PERFORMANCE_BUDGETS = Object.freeze({
  INITIAL_STATIC_JS: Object.freeze({ raw: 900_000, gzip: 260_000 }),
  CHART: Object.freeze({ raw: 200_000, gzip: 65_000 }),
  MACRO: Object.freeze({ raw: 30_000, gzip: 8_000 }),
  RESEARCH: Object.freeze({ raw: 25_000, gzip: 6_000 }),
});

const ROUTES = Object.freeze({
  CHART: "src/views/ChartView.tsx",
  MACRO: "src/views/MacroViewV2.tsx",
  RESEARCH: "src/views/ResearchRulesView.tsx",
});

function fail(message) {
  throw new Error(`[performance-budget] ${message}`);
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    fail(`manifest is missing: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`manifest is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
    fail("manifest root must be an object");
  }
  return manifest;
}

function validateEntry(key, entry, manifest) {
  if (!entry || typeof entry !== "object" || typeof entry.file !== "string" || entry.file.length === 0) {
    fail(`manifest entry is malformed: ${key}`);
  }
  if (entry.imports !== undefined && !Array.isArray(entry.imports)) {
    fail(`manifest imports must be an array: ${key}`);
  }
  for (const importedKey of entry.imports ?? []) {
    if (typeof importedKey !== "string" || !manifest[importedKey]) {
      fail(`manifest static import is missing: ${key} -> ${String(importedKey)}`);
    }
  }
}

function collectGraph(manifest, startKey) {
  const keys = new Set();
  const visit = (key) => {
    if (keys.has(key)) return;
    const entry = manifest[key];
    validateEntry(key, entry, manifest);
    keys.add(key);
    for (const importedKey of entry.imports ?? []) visit(importedKey);
  };
  visit(startKey);
  return [...keys];
}

function bytesForFile(outDir, file) {
  const filePath = path.join(outDir, file);
  if (!fs.existsSync(filePath)) fail(`emitted file is missing: ${file}`);
  const bytes = fs.readFileSync(filePath);
  return {
    file,
    raw: bytes.byteLength,
    gzip: zlib.gzipSync(bytes).byteLength,
  };
}

function graphBytes(manifest, outDir, keys, excludedFiles = new Set()) {
  const files = new Map();
  for (const key of keys) {
    const entry = manifest[key];
    validateEntry(key, entry, manifest);
    if (!excludedFiles.has(entry.file) && !files.has(entry.file)) {
      files.set(entry.file, bytesForFile(outDir, entry.file));
    }
  }
  const contributors = [...files.values()].sort((left, right) => right.raw - left.raw || left.file.localeCompare(right.file));
  return {
    raw: contributors.reduce((sum, item) => sum + item.raw, 0),
    gzip: contributors.reduce((sum, item) => sum + item.gzip, 0),
    contributors,
  };
}

function findApplicationEntry(manifest) {
  const candidates = Object.entries(manifest).filter(([, entry]) => entry?.isEntry === true);
  if (candidates.length !== 1) {
    fail(`expected exactly one application entry, found ${candidates.length}`);
  }
  return candidates[0][0];
}

function assertBudget(name, measured, budget) {
  const failures = [];
  if (measured.raw > budget.raw) failures.push(`raw ${measured.raw} > ${budget.raw}`);
  if (measured.gzip > budget.gzip) failures.push(`gzip ${measured.gzip} > ${budget.gzip}`);
  if (failures.length > 0) fail(`${name} budget exceeded: ${failures.join(", ")}`);
}

function printGraph(name, measured, budget) {
  console.log(`${name}: raw ${measured.raw}/${budget.raw}, gzip ${measured.gzip}/${budget.gzip}`);
  for (const item of measured.contributors) {
    console.log(`  ${item.file}: raw ${item.raw}, gzip ${item.gzip}`);
  }
}

export function checkPerformanceBudget({ outDir = "dist", manifestPath, printReport = true } = {}) {
  const resolvedOutDir = path.resolve(outDir);
  const resolvedManifestPath = path.resolve(manifestPath ?? path.join(resolvedOutDir, ".vite", "manifest.json"));
  const manifest = readManifest(resolvedManifestPath);
  const entryKey = findApplicationEntry(manifest);
  const initial = graphBytes(manifest, resolvedOutDir, collectGraph(manifest, entryKey));
  assertBudget("INITIAL_STATIC_JS", initial, PERFORMANCE_BUDGETS.INITIAL_STATIC_JS);

  const initialFiles = new Set(initial.contributors.map((item) => item.file));
  const routes = {};
  for (const [name, routeKey] of Object.entries(ROUTES)) {
    const routeEntry = manifest[routeKey];
    validateEntry(routeKey, routeEntry, manifest);
    if (routeEntry.isDynamicEntry !== true) fail(`${name} route is not a dynamic entry: ${routeKey}`);
    routes[name] = {
      key: routeKey,
      file: routeEntry.file,
      measured: graphBytes(manifest, resolvedOutDir, collectGraph(manifest, routeKey), initialFiles),
    };
    assertBudget(name, routes[name].measured, PERFORMANCE_BUDGETS[name]);
  }

  const routeFiles = Object.values(routes).map((route) => route.file);
  if (new Set(routeFiles).size !== routeFiles.length) fail(`dynamic route entries collapsed: ${routeFiles.join(", ")}`);

  const result = { entryKey, initial, routes };
  if (printReport) {
    console.log(`Manifest: ${resolvedManifestPath}`);
    printGraph("INITIAL_STATIC_JS", initial, PERFORMANCE_BUDGETS.INITIAL_STATIC_JS);
    for (const [name, route] of Object.entries(routes)) printGraph(name, route.measured, PERFORMANCE_BUDGETS[name]);
    console.log(`Distinct routes: ${routeFiles.join(", ")}`);
    console.log("Performance budgets: PASS");
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    checkPerformanceBudget({ outDir: process.argv[2] ?? "dist" });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
