import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkPerformanceBudget } from "./check-performance-budget.mjs";

const ROUTES = {
  chart: "src/views/ChartView.tsx",
  macro: "src/views/MacroViewV2.tsx",
  research: "src/views/ResearchRulesView.tsx",
};

function fixture({ collapseRoutes = false, omitResearch = false, oversizedInitial = false } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "quantfund-perf-"));
  const write = (file, content) => {
    const target = path.join(outDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const mainFile = "assets/main.js";
  const sharedFile = "assets/shared.js";
  const routeFile = "assets/route.js";
  write(mainFile, oversizedInitial ? "a".repeat(900_001) : "main");
  write(sharedFile, "shared");
  write(routeFile, "route");
  const manifest = {
    "index.html": { file: mainFile, isEntry: true, imports: ["_shared.js"] },
    "_shared.js": { file: sharedFile },
    [ROUTES.chart]: { file: collapseRoutes ? routeFile : "assets/chart.js", isDynamicEntry: true, imports: ["_shared.js"] },
    [ROUTES.macro]: { file: collapseRoutes ? routeFile : "assets/macro.js", isDynamicEntry: true, imports: ["_shared.js"] },
    [ROUTES.research]: { file: collapseRoutes ? routeFile : "assets/research.js", isDynamicEntry: true, imports: ["_shared.js"] },
  };
  if (!collapseRoutes) {
    write("assets/chart.js", "chart");
    write("assets/macro.js", "macro");
    write("assets/research.js", "research");
  }
  if (omitResearch) delete manifest[ROUTES.research];
  const manifestPath = path.join(outDir, ".vite", "manifest.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { outDir, manifestPath };
}

function removeFixture({ outDir }) {
  fs.rmSync(outDir, { recursive: true, force: true });
}

test("accepts a valid manifest graph", () => {
  const current = fixture();
  try {
    const result = checkPerformanceBudget({ ...current, printReport: false });
    assert.equal(result.routes.CHART.file, "assets/chart.js");
    assert.equal(new Set(Object.values(result.routes).map((route) => route.file)).size, 3);
  } finally {
    removeFixture(current);
  }
});

test("rejects an over-budget initial graph", () => {
  const current = fixture({ oversizedInitial: true });
  try {
    assert.throws(() => checkPerformanceBudget({ ...current, printReport: false }), /INITIAL_STATIC_JS budget exceeded/);
  } finally {
    removeFixture(current);
  }
});

test("rejects a missing expected route", () => {
  const current = fixture({ omitResearch: true });
  try {
    assert.throws(() => checkPerformanceBudget({ ...current, printReport: false }), /manifest entry is malformed: src\/views\/ResearchRulesView\.tsx/);
  } finally {
    removeFixture(current);
  }
});

test("rejects collapsed dynamic route entries", () => {
  const current = fixture({ collapseRoutes: true });
  try {
    assert.throws(() => checkPerformanceBudget({ ...current, printReport: false }), /dynamic route entries collapsed/);
  } finally {
    removeFixture(current);
  }
});
