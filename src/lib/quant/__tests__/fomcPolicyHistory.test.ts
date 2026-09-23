import { describe, expect, it } from "vitest";
import { latestEligibleEvent, latestEligibleMacroRelease } from "../historicalPit";
import { BLS_CPI_MOM_STATUS } from "../historicalSources/blsCpiHistory";
import {
  FOMC_POLICY_PARSER_VERSION,
  FOMC_POLICY_SUPPORTED_END,
  FOMC_POLICY_SUPPORTED_START,
  FOMC_SUPPORTED_EVENT_DATES,
  acquireFomcPolicyHistory,
  createFomcPolicyUrls,
  processFomcPolicyHistory,
  type FomcPolicyArtifactPairInput,
} from "../historicalSources/fomcPolicyHistory";
import { RESEARCH_SERIES_SPECS, validateResearchDatasetManifest } from "../researchDataProtocol";

const enc = new TextEncoder();
const retrievedAt = "2026-09-23T00:00:00.000Z";
const through = Date.parse("2026-09-23T00:00:00.000Z");

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function longDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return `${monthNames[month - 1]} ${day}, ${year}`;
}

function pair(input: {
  date: string;
  zone: "EST" | "EDT";
  action: "keep" | "maintain" | "raise" | "lower";
  lower: string;
  upper: string;
  effectiveDate: string;
  releaseTime?: string;
  statementExtra?: string;
  noteExtra?: string;
}): FomcPolicyArtifactPairInput {
  const urls = createFomcPolicyUrls(input.date);
  const by = input.action === "raise" || input.action === "lower" ? " by 1/4 percentage point" : "";
  const preposition = input.action === "keep" || input.action === "maintain" ? "at" : "to";
  return {
    ...urls,
    statementBytes: enc.encode(`
      <html><body><div>${longDate(input.date)}</div>
      <div>For release at ${input.releaseTime ?? "2:00"} p.m. ${input.zone}</div>
      <p>The Committee decided to ${input.action} the target range for the federal funds rate${by} ${preposition} ${input.lower} to ${input.upper} percent.</p>
      ${input.statementExtra ?? ""}</body></html>`),
    implementationNoteBytes: enc.encode(`
      <html><body><div>${longDate(input.date)}</div>
      <h1>Implementation Note issued ${longDate(input.date)}</h1>
      <p>Effective ${longDate(input.effectiveDate)}, the Federal Open Market Committee directs the Desk to:</p>
      <p>Undertake open market operations as necessary to maintain the federal funds rate in a target range of ${input.lower} to ${input.upper} percent.</p>
      ${input.noteExtra ?? ""}</body></html>`),
    retrievedAt,
  };
}

const unchanged = pair({
  date: "2021-01-27",
  zone: "EST",
  action: "keep",
  lower: "0",
  upper: "1/4",
  effectiveDate: "2021-01-28",
});
const increase = pair({
  date: "2022-03-16",
  zone: "EDT",
  action: "raise",
  lower: "1/4",
  upper: "1/2",
  effectiveDate: "2022-03-17",
});
const hold = pair({
  date: "2023-06-14",
  zone: "EDT",
  action: "maintain",
  lower: "5",
  upper: "5-1/4",
  effectiveDate: "2023-06-15",
});
const decrease = pair({
  date: "2024-09-18",
  zone: "EDT",
  action: "lower",
  lower: "4-3/4",
  upper: "5",
  effectiveDate: "2024-09-19",
});

function processOne(artifact: FomcPolicyArtifactPairInput, releasedThroughMs = through) {
  const date = /monetary(\d{4})(\d{2})(\d{2})a\.htm/u.exec(artifact.statementUrl)!;
  return processFomcPolicyHistory({
    artifacts: [artifact],
    releasedThroughMs,
    expectedEventDates: [`${date[1]}-${date[2]}-${date[3]}`],
  });
}

describe("B2-B5 FOMC policy history", () => {
  it("accepts a valid unchanged decision", () => {
    const result = processOne(unchanged);
    expect(result.decisionEvidence[0].action).toBe("MAINTAIN");
    expect(result.eventRecords[0].actual).toBe(0.25);
  });

  it("accepts a valid rate increase", () => {
    expect(processOne(increase).decisionEvidence[0].action).toBe("RAISE");
  });

  it("accepts a valid rate decrease", () => {
    expect(processOne(decrease).decisionEvidence[0].action).toBe("LOWER");
  });

  it("converts an EST release with historical DST", () => {
    expect(new Date(processOne(unchanged).eventRecords[0].availableAt).toISOString()).toBe("2021-01-27T19:00:00.000Z");
  });

  it("converts an EDT release with historical DST", () => {
    expect(new Date(processOne(increase).eventRecords[0].availableAt).toISOString()).toBe("2022-03-16T18:00:00.000Z");
  });

  it("is visible exactly at the 2 p.m. release boundary", () => {
    const result = processOne(increase);
    const event = result.eventRecords[0];
    expect(latestEligibleEvent(result.eventRecords, event.availableAt - 1)).toBeNull();
    expect(latestEligibleEvent(result.eventRecords, event.availableAt)?.eventId).toBe(event.eventId);
  });

  it("rejects a statement beyond releasedThroughMs", () => {
    expect(() => processOne(increase, Date.parse("2022-03-16T17:59:59.999Z"))).toThrow(/no statements were public/);
  });

  it("keeps event date distinct from availability", () => {
    const event = processOne(increase).eventRecords[0];
    expect(event.observationTime).toBe(Date.parse("2022-03-16T00:00:00.000Z"));
    expect(event.availableAt).not.toBe(event.observationTime);
  });

  it("keeps public availability distinct from effective date boundary", () => {
    const evidence = processOne(increase).decisionEvidence[0];
    expect(evidence.availableAt).not.toBe(evidence.effectiveAt);
    expect(new Date(evidence.effectiveAt).toISOString()).toBe("2022-03-17T04:00:00.000Z");
  });

  it("does not expose announced target state before effective boundary", () => {
    const result = processOne(increase);
    const evidence = result.decisionEvidence[0];
    expect(latestEligibleMacroRelease(result.macroReleases, "US_FED_FUNDS_TARGET_UPPER", evidence.effectiveAt - 1)).toBeNull();
    expect(latestEligibleMacroRelease(result.macroReleases, "US_FED_FUNDS_TARGET_UPPER", evidence.effectiveAt)?.value).toBe(0.5);
  });

  it("still exposes the policy decision at public release", () => {
    const result = processOne(increase);
    const evidence = result.decisionEvidence[0];
    expect(latestEligibleEvent(result.eventRecords, evidence.availableAt)?.actual).toBe(0.5);
  });

  it("parses mixed-fraction target upper", () => {
    expect(processOne(hold).decisionEvidence[0].targetUpper).toBe(5.25);
  });

  it("parses mixed-fraction target lower", () => {
    expect(processOne(decrease).decisionEvidence[0].targetLower).toBe(4.75);
  });

  it("rejects malformed ranges", () => {
    const bad = pair({ date: "2022-03-16", zone: "EDT", action: "raise", lower: "1/0", upper: "1/2", effectiveDate: "2022-03-17" });
    expect(() => processOne(bad)).toThrow(/fraction|target range/);
  });

  it("rejects lower bound above upper bound", () => {
    const bad = pair({ date: "2022-03-16", zone: "EDT", action: "raise", lower: "3/4", upper: "1/2", effectiveDate: "2022-03-17" });
    expect(() => processOne(bad)).toThrow(/lower bound exceeds/);
  });

  it("rejects missing release time", () => {
    const bad = { ...increase, statementBytes: enc.encode(`<div>${longDate("2022-03-16")}</div><p>The Committee decided to raise the target range for the federal funds rate to 1/4 to 1/2 percent.</p>`) };
    expect(() => processOne(bad)).toThrow(/release at/);
  });

  it("rejects conflicting release times", () => {
    const bad = { ...increase, statementBytes: enc.encode(`${new TextDecoder().decode(increase.statementBytes)} For release at 2:01 p.m. EDT`) };
    expect(() => processOne(bad)).toThrow(/conflicting/);
  });

  it("rejects an exact duplicate official event", () => {
    expect(() => processFomcPolicyHistory({ artifacts: [increase, increase], releasedThroughMs: through, expectedEventDates: ["2022-03-16"] })).toThrow(/duplicate official event/);
  });

  it("rejects a conflicting duplicate official event", () => {
    const conflict = { ...increase, statementBytes: enc.encode(new TextDecoder().decode(increase.statementBytes).replace("1/4 to 1/2", "1/2 to 3/4")) };
    expect(() => processFomcPolicyHistory({ artifacts: [increase, conflict], releasedThroughMs: through, expectedEventDates: ["2022-03-16"] })).toThrow(/duplicate official event/);
  });

  it("rejects unsupported historical regimes", () => {
    expect(() => createFomcPolicyUrls("2020-03-15")).toThrow(/unsupported/);
  });

  it("rejects corrected or reissued statements", () => {
    const bad = pair({ date: "2022-03-16", zone: "EDT", action: "raise", lower: "1/4", upper: "1/2", effectiveDate: "2022-03-17", statementExtra: "Correction notice" });
    expect(() => processOne(bad)).toThrow(/corrected\/reissued/);
  });

  it("rejects statement/implementation range conflicts", () => {
    const bad = { ...increase, implementationNoteBytes: enc.encode(new TextDecoder().decode(increase.implementationNoteBytes).replace("1/4 to 1/2", "1/2 to 3/4")) };
    expect(() => processOne(bad)).toThrow(/target-range conflict/);
  });

  it("rejects conflicting effective dates", () => {
    const bad = { ...increase, implementationNoteBytes: enc.encode(`${new TextDecoder().decode(increase.implementationNoteBytes)} Effective March 18, 2022, the Federal Open Market Committee directs the Desk to:`) };
    expect(() => processOne(bad)).toThrow(/conflicting effective/);
  });

  it("sorts deterministically regardless of artifact order", () => {
    const expectedEventDates = ["2021-01-27", "2022-03-16"];
    const a = processFomcPolicyHistory({ artifacts: [increase, unchanged], releasedThroughMs: through, expectedEventDates });
    const b = processFomcPolicyHistory({ artifacts: [unchanged, increase], releasedThroughMs: through, expectedEventDates });
    expect(a.eventRecords).toEqual(b.eventRecords);
    expect(a.normalizedContentHash).toBe(b.normalizedContentHash);
  });

  it("changes normalized identity when release time changes", () => {
    const changed = pair({ date: "2022-03-16", zone: "EDT", action: "raise", lower: "1/4", upper: "1/2", effectiveDate: "2022-03-17", releaseTime: "2:01" });
    expect(processOne(changed).normalizedContentHash).not.toBe(processOne(increase).normalizedContentHash);
  });

  it("changes normalized identity when target changes", () => {
    const changed = pair({ date: "2022-03-16", zone: "EDT", action: "raise", lower: "1/2", upper: "3/4", effectiveDate: "2022-03-17" });
    expect(processOne(changed).normalizedContentHash).not.toBe(processOne(increase).normalizedContentHash);
  });

  it("changes normalized identity when effective date changes", () => {
    const changed = pair({ date: "2022-03-16", zone: "EDT", action: "raise", lower: "1/4", upper: "1/2", effectiveDate: "2022-03-18" });
    expect(processOne(changed).normalizedContentHash).not.toBe(processOne(increase).normalizedContentHash);
  });

  it("does not change normalized identity when retrieval time changes", () => {
    const changed = { ...increase, retrievedAt: "2026-09-23T01:00:00.000Z" };
    expect(processOne(changed).normalizedContentHash).toBe(processOne(increase).normalizedContentHash);
  });

  it("computes deterministic raw SHA identities", () => {
    expect(processOne(increase).artifacts.map((artifact) => artifact.rawSha256)).toEqual(processOne(increase).artifacts.map((artifact) => artifact.rawSha256));
  });

  it("uses truthful NOT_PUBLISHED provider checksum semantics", () => {
    expect(processOne(increase).artifacts.every((artifact) => artifact.providerChecksum === null && artifact.request.checksumUrl === null)).toBe(true);
  });

  it("builds the canonical FOMC_RATE_DECISION manifest", () => {
    const entry = processOne(increase).manifestEntries[0];
    expect(entry).toMatchObject({ seriesId: "FOMC_RATE_DECISION", kind: "OFFICIAL_EVENT", cadence: "EVENT_DRIVEN", revisionSemantics: "NOT_APPLICABLE" });
  });

  it("builds the canonical target-upper manifest", () => {
    const entry = processOne(increase).manifestEntries[1];
    expect(entry).toMatchObject({ seriesId: "US_FED_FUNDS_TARGET_UPPER", kind: "MACRO_RELEASE", cadence: "EVENT_DRIVEN", revisionSemantics: "INITIAL_ONLY" });
  });

  it("matches the frozen canonical research series specs", () => {
    expect(RESEARCH_SERIES_SPECS.FOMC_RATE_DECISION).toMatchObject({ kind: "OFFICIAL_EVENT", cadence: "EVENT_DRIVEN", revisionSemantics: "NOT_APPLICABLE" });
    expect(RESEARCH_SERIES_SPECS.US_FED_FUNDS_TARGET_UPPER).toMatchObject({ kind: "MACRO_RELEASE", cadence: "EVENT_DRIVEN", revisionSemantics: "INITIAL_ONLY" });
  });

  it("remains RESEARCH_ONLY", () => {
    expect(processOne(increase).intendedUse).toBe("RESEARCH_ONLY");
  });

  it("remains RESEARCH_CONTEXT_ONLY", () => {
    expect(processOne(increase).priceAuthority).toBe("RESEARCH_CONTEXT_ONLY");
  });

  it("does not emit assetBars", () => {
    expect(processOne(increase)).not.toHaveProperty("assetBars");
  });

  it("does not emit execution, allocation, ledger, or accounting outputs", () => {
    const result = processOne(increase);
    expect(result).not.toHaveProperty("executions");
    expect(result).not.toHaveProperty("targetWeights");
    expect(result).not.toHaveProperty("ledger");
    expect(result).not.toHaveProperty("nav");
  });

  it("does not claim whole-dataset RESEARCH_READY", () => {
    expect(processOne(increase)).not.toHaveProperty("readiness");
  });

  it("retains CPI MoM conditional status", () => {
    expect(BLS_CPI_MOM_STATUS).toBe("CONDITIONAL");
  });

  it("uses event-driven expected-event missingness", () => {
    const result = processFomcPolicyHistory({
      artifacts: [unchanged],
      releasedThroughMs: Date.parse("2021-04-29T04:00:00.000Z"),
      expectedEventDates: ["2021-01-27", "2021-03-17", "2021-04-28"],
    });
    expect(result.coverage.missingEventDates).toEqual(["2021-03-17", "2021-04-28"]);
    expect(result.coverage.method).not.toMatch(/daily|monthly denominator/iu);
  });

  it("emits one INITIAL_ONLY target value for unchanged decisions", () => {
    const result = processOne(unchanged);
    expect(result.macroReleases).toHaveLength(1);
    expect(result.macroReleases[0]).toMatchObject({ revisionIndex: 0, value: 0.25 });
  });

  it("preserves action transitions and change amounts across ordered decisions", () => {
    const firstRaise = pair({ date: "2021-03-17", zone: "EDT", action: "raise", lower: "1/4", upper: "1/2", effectiveDate: "2021-03-18" });
    const sameTarget = pair({ date: "2021-04-28", zone: "EDT", action: "maintain", lower: "1/4", upper: "1/2", effectiveDate: "2021-04-29" });
    const firstCut = pair({ date: "2021-06-16", zone: "EDT", action: "lower", lower: "0", upper: "1/4", effectiveDate: "2021-06-17" });
    const result = processFomcPolicyHistory({
      artifacts: [firstCut, unchanged, sameTarget, firstRaise],
      releasedThroughMs: through,
      expectedEventDates: ["2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16"],
    });
    expect(result.decisionEvidence.map((item) => [item.action, item.changeAmount])).toEqual([
      ["MAINTAIN", null], ["RAISE", 0.25], ["MAINTAIN", 0], ["LOWER", 0.25],
    ]);
  });

  it("fails when maintain changes the prior upper bound", () => {
    const badHold = pair({ date: "2021-03-17", zone: "EDT", action: "maintain", lower: "1/4", upper: "1/2", effectiveDate: "2021-03-18" });
    expect(() => processFomcPolicyHistory({ artifacts: [unchanged, badHold], releasedThroughMs: through, expectedEventDates: ["2021-01-27", "2021-03-17"] })).toThrow(/maintain but changes/);
  });

  it("retains a released event when target state is not effective yet", () => {
    const release = Date.parse("2022-03-16T18:00:00.000Z");
    const result = processOne(increase, release);
    expect(result.eventRecords).toHaveLength(1);
    expect(result.macroReleases).toHaveLength(0);
  });

  it("does not leak future artifacts, provenance, identity, or coverage across releasedThroughMs", () => {
    const beforeFutureRelease = Date.parse("2021-01-29T00:00:00.000Z");
    const early = processFomcPolicyHistory({
      artifacts: [increase, unchanged],
      releasedThroughMs: beforeFutureRelease,
      expectedEventDates: ["2021-01-27", "2022-03-16"],
    });
    const publicOnly = processFomcPolicyHistory({
      artifacts: [unchanged],
      releasedThroughMs: beforeFutureRelease,
      expectedEventDates: ["2021-01-27", "2022-03-16"],
    });
    const afterFutureRelease = processFomcPolicyHistory({
      artifacts: [increase, unchanged],
      releasedThroughMs: Date.parse("2022-03-16T18:00:00.000Z"),
      expectedEventDates: ["2021-01-27", "2022-03-16"],
    });
    const afterFutureEffective = processFomcPolicyHistory({
      artifacts: [increase, unchanged],
      releasedThroughMs: Date.parse("2022-03-17T04:00:00.000Z"),
      expectedEventDates: ["2021-01-27", "2022-03-16"],
    });
    const futureArtifact = afterFutureRelease.artifacts.find(
      (artifact) => artifact.request.url === increase.statementUrl
    )!;
    const earlySerialized = JSON.stringify(early);
    const earlyProvenance = early.manifestEntries.map((entry) => entry.provenance).join("\n");

    expect(early.eventRecords.map((event) => event.eventId)).toEqual(["FED-FOMC-20210127"]);
    expect(early.decisionEvidence.map((item) => item.eventId)).toEqual(["FED-FOMC-20210127"]);
    expect(early.artifacts).toHaveLength(2);
    expect(early.artifacts.every((artifact) => artifact.request.url.includes("20210127"))).toBe(true);
    expect(earlyProvenance).not.toContain(increase.statementUrl);
    expect(earlyProvenance).not.toContain(increase.implementationNoteUrl);
    expect(earlyProvenance).not.toContain(futureArtifact.artifactId);
    expect(earlyProvenance).not.toContain(futureArtifact.rawSha256);
    expect(early.normalizedContentHash).toBe(publicOnly.normalizedContentHash);
    expect(early.coverage.lastEventDate).toBe("2021-01-27");
    expect(early.coverage.eventCount).toBe(1);
    expect(early.coverage.targetUpperCount).toBe(1);
    expect(earlySerialized).not.toContain("monetary20220316");
    expect(earlySerialized).not.toContain("FED-FOMC-20220316");

    expect(afterFutureRelease.eventRecords).toHaveLength(2);
    expect(afterFutureRelease.decisionEvidence).toHaveLength(2);
    expect(afterFutureRelease.artifacts).toHaveLength(4);
    expect(afterFutureRelease.coverage.lastEventDate).toBe("2022-03-16");
    expect(afterFutureRelease.macroReleases).toHaveLength(1);
    expect(afterFutureEffective.macroReleases).toHaveLength(2);
  });

  it("uses one explicit supported regular-event inventory", () => {
    expect(FOMC_SUPPORTED_EVENT_DATES[0]).toBe(FOMC_POLICY_SUPPORTED_START);
    expect(FOMC_SUPPORTED_EVENT_DATES.at(-1)).toBe(FOMC_POLICY_SUPPORTED_END);
    expect(new Set(FOMC_SUPPORTED_EVENT_DATES).size).toBe(FOMC_SUPPORTED_EVENT_DATES.length);
  });

  it("generates only official statement and implementation-note URLs", () => {
    expect(createFomcPolicyUrls("2024-09-18")).toEqual({
      statementUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20240918a.htm",
      implementationNoteUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20240918a1.htm",
    });
  });

  it("keeps the parser version explicit", () => {
    expect(FOMC_POLICY_PARSER_VERSION).toBe("M13B2-FOMC-POLICY-HTML-V1");
  });

  it("uses an injectable thin acquisition boundary", async () => {
    const urls = createFomcPolicyUrls("2022-03-16");
    const responses = new Map([[urls.statementUrl, increase.statementBytes], [urls.implementationNoteUrl, increase.implementationNoteBytes]]);
    const calls: string[] = [];
    const result = await acquireFomcPolicyHistory(
      { eventDates: ["2022-03-16"], retrievedAt, releasedThroughMs: through },
      { fetchBinary: async (url) => { calls.push(url); return responses.get(url)!; } }
    );
    expect(calls.sort()).toEqual([urls.implementationNoteUrl, urls.statementUrl].sort());
    expect(result.eventRecords).toHaveLength(1);
  });

  it("produces manifest entries accepted by protocol validation", () => {
    const result = processOne(increase);
    const startTime = Math.min(...result.manifestEntries.map((entry) => Math.min(entry.firstObservationTime, entry.firstAvailableAt)));
    const endTime = Math.max(...result.manifestEntries.map((entry) => Math.max(entry.lastObservationTime, entry.lastAvailableAt)));
    expect(() => validateResearchDatasetManifest({
      datasetId: "fomc-fixture",
      schemaVersion: "M13B-1.1",
      createdAt: "2026-09-23T00:00:00.000Z",
      interval: "1h",
      intendedUse: "RESEARCH_ONLY",
      priceAuthority: "RESEARCH_CONTEXT_ONLY",
      pitPolicy: "DEC-015/PIT-AVAILABLE-AT-V1",
      snapshotHash: "sha256:test",
      startTime,
      endTime,
      totalRecordCount: 2,
      sources: result.manifestEntries,
    })).not.toThrow();
  });
});
