import { useMemo, useSyncExternalStore } from "react";
import { Database, FlaskConical, Link2, ShieldAlert } from "lucide-react";
import { Panel } from "@/components/ui/Panel";
import { canonicalResearchRuntimeStateSource } from "@/lib/quant/canonicalResearchRuntimeState";
import { presentCanonicalResearchRuntimeState } from "@/lib/researchRulesPresenter";
import { clsx } from "@/lib/clsx";

function Identity({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">{label}</div>
      <div className="mt-1 break-all font-mono text-[10px] leading-4 text-ink">{value}</div>
    </div>
  );
}

export function ResearchRulesView() {
  const state = useSyncExternalStore(
    canonicalResearchRuntimeStateSource.subscribe,
    canonicalResearchRuntimeStateSource.getSnapshot,
    canonicalResearchRuntimeStateSource.getSnapshot
  );
  const presentation = useMemo(() => presentCanonicalResearchRuntimeState(state), [state]);

  if (presentation.availability === "UNAVAILABLE") {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-[#07090d] p-3">
        <Panel title="Research / Rules" right="READ-ONLY · CANONICAL SOURCE">
          <div className="flex min-h-[320px] items-center justify-center">
            <div className="max-w-2xl border border-amber/35 bg-amber/5 p-6 text-center">
              <Database className="mx-auto text-amber" size={28} />
              <h1 className="mt-4 font-mono text-sm font-semibold tracking-[0.12em] text-ink">
                {presentation.title}
              </h1>
              <div className="mt-3 font-mono text-[10px] tracking-[0.12em] text-amber">
                {presentation.reasonCode}
              </div>
              <p className="mt-3 text-sm leading-6 text-muted">{presentation.reason}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{presentation.explanation}</p>
              <div className="mt-5 border-t border-line pt-4 text-[11px] leading-5 text-muted">
                This state does not mean research failed, evidence was rejected, or canonical trading action is invalid.
              </div>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto bg-[#07090d] p-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Panel title="Canonical research state" right={`${presentation.entryCount} EVIDENCE ENTRIES`}>
          <div className="flex items-start gap-3">
            <FlaskConical className="mt-0.5 shrink-0 text-cyan" size={20} />
            <div>
              <div className="font-mono text-sm font-semibold text-ink">{presentation.title}</div>
              <p className="mt-2 text-xs leading-5 text-muted">
                Validated research artifacts are available for deterministic, read-only inspection.
              </p>
            </div>
          </div>
        </Panel>
        <Panel title="Methodology capability" right="M13 CURRENT">
          <div className="space-y-2 font-mono text-[10px]">
            <div className="text-muted">SUPPORTED INSTANCES</div>
            <div className="text-cyan">{presentation.supportedEvidenceStatuses.join(" · ")}</div>
            <div className="pt-1 text-muted">DECLARED BUT UNAVAILABLE</div>
            <div className="text-amber">{presentation.unavailableEvidenceStatuses.join(" · ")}</div>
          </div>
        </Panel>
        <Panel title="Authority boundary" right="EXPLANATORY ONLY">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 shrink-0 text-amber" size={18} />
            <p className="text-xs leading-5 text-muted">
              Research evidence, StrategyEligibility, and canonical ActionDecision are separate contracts. This view grants no trading or financial authority.
            </p>
          </div>
        </Panel>
      </div>

      {presentation.entries.length === 0 ? (
        <Panel title="Evidence inventory" right="AVAILABLE · EMPTY">
          <p className="text-sm text-muted">The canonical registries are available, but contain no evidence entries.</p>
        </Panel>
      ) : presentation.entries.map((entry) => (
        <Panel
          key={entry.evidenceSemanticIdentity}
          title={`${entry.hypothesisId} · ${entry.assetId}`}
          right={`${entry.hypothesisVersion} · ${entry.ruleId}@${entry.ruleVersion}`}
        >
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-4">
              <div>
                <h2 className="font-mono text-sm font-semibold text-ink">{entry.hypothesisTitle}</h2>
                <p className="mt-1 text-xs leading-5 text-muted">{entry.hypothesisDescription}</p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="border border-line bg-panel-2 p-3">
                  <div className="font-mono text-[9px] tracking-[0.16em] text-muted">RESEARCH EVIDENCE CLASSIFICATION</div>
                  <div className={clsx(
                    "mt-2 inline-flex border px-2 py-1 font-mono text-[11px] font-semibold",
                    entry.evidenceStatus === "CANDIDATE"
                      ? "border-cyan/40 bg-cyan/10 text-cyan"
                      : "border-amber/40 bg-amber/10 text-amber"
                  )}>
                    {entry.evidenceStatus}
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-muted">{entry.evidenceMeaning}</p>
                </div>
                <div className="border border-line bg-panel-2 p-3">
                  <div className="font-mono text-[9px] tracking-[0.16em] text-muted">STRATEGY ELIGIBILITY</div>
                  <div className="mt-2 break-words font-mono text-[11px] font-semibold text-ink">
                    {entry.eligibility?.status ?? "NOT_PUBLISHED"}
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-muted">
                    {entry.eligibility
                      ? "Exact linked paper-evaluation admission status; not a trading action."
                      : "No canonical StrategyEligibility registry was published. Eligibility is not derived by this view."}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <div className="font-mono text-[9px] tracking-[0.16em] text-muted">TRAIN INTERVAL</div>
                  <div className="mt-1 font-mono text-[10px] text-ink">{entry.trainingInterval}</div>
                </div>
                <div>
                  <div className="font-mono text-[9px] tracking-[0.16em] text-muted">OOS INTERVAL</div>
                  <div className="mt-1 font-mono text-[10px] text-ink">{entry.oosInterval}</div>
                </div>
                <div>
                  <div className="font-mono text-[9px] tracking-[0.16em] text-muted">STATEFUL OOS POLICY</div>
                  <div className="mt-1 font-mono text-[10px] text-ink">{entry.statefulOosBoundaryPolicy}</div>
                </div>
                <div>
                  <div className="font-mono text-[9px] tracking-[0.16em] text-muted">DECLARED PARAMETERS</div>
                  <div className="mt-1 font-mono text-[10px] text-ink">
                    {entry.declaredParameters.length > 0 ? entry.declaredParameters.join(" · ") : "NONE"}
                  </div>
                </div>
              </div>

              <div>
                <div className="font-mono text-[9px] tracking-[0.16em] text-muted">CLASSIFICATION REASONS</div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entry.classificationReasons.map((reason) => (
                    <span key={reason} className="border border-line bg-panel-2 px-2 py-1 font-mono text-[9px] text-ink">
                      {reason}
                    </span>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-2">
                <div className="border-l-2 border-amber/50 pl-2">
                  <span className="font-mono text-muted">PROMOTION: </span>
                  <span className="font-mono text-amber">{entry.promotionDisposition}</span>
                </div>
                <div className="border-l-2 border-amber/50 pl-2">
                  <span className="font-mono text-muted">REJECTION: </span>
                  <span className="font-mono text-amber">{entry.rejectionDisposition}</span>
                </div>
              </div>
            </div>

            <div className="space-y-4 border-t border-line pt-4 xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
              <div className="flex items-center gap-2 font-mono text-[10px] tracking-[0.14em] text-cyan">
                <Link2 size={13} /> CANONICAL IDENTITIES / PROVENANCE
              </div>
              <Identity label="Hypothesis identity" value={entry.hypothesisSemanticIdentity} />
              <Identity label="Rule identity" value={entry.ruleSemanticIdentity} />
              <Identity label="Parameter configuration identity" value={entry.parameterConfigurationIdentity} />
              <Identity label="Held-out OOS evidence identity" value={entry.heldOutEvidenceSemanticIdentity} />
              <Identity label="Evidence identity" value={entry.evidenceSemanticIdentity} />
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted">Shared-OOS robustness</div>
                <div className="mt-1 font-mono text-[10px] leading-4 text-ink">
                  {entry.robustness
                    ? `${entry.robustness.familyId}@${entry.robustness.familyVersion} · ${entry.robustness.familyCompleteness} · ${entry.robustness.memberCompleteness} · ${entry.robustness.interpretation}`
                    : "NOT_PUBLISHED"}
                </div>
              </div>
              {entry.provenance.map((item) => (
                <Identity
                  key={`${item.kind}:${item.semanticIdentity}`}
                  label={`${item.kind} · ${item.schemaVersion}`}
                  value={item.semanticIdentity}
                />
              ))}
            </div>
          </div>
        </Panel>
      ))}
    </div>
  );
}
