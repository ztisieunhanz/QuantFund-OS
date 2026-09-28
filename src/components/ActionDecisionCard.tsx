import { AlertTriangle, CheckCircle2, Clock3, Shield, Target } from "lucide-react";
import { clsx } from "@/lib/clsx";
import { presentActionDecision } from "@/lib/actionDecisionPresenter";
import type { ActionDecision, ActionDecisionAction } from "@/lib/quant/actionDecision";
import type { OperationalTruthState } from "@/lib/quant/operationalPaperContract";

const ACTION_TONE: Readonly<Record<ActionDecisionAction, string>> = Object.freeze({
  WAIT: "border-amber/50 bg-amber/10 text-amber",
  ENTER: "border-up/50 bg-up/10 text-up",
  ADD: "border-cyan/50 bg-cyan/10 text-cyan",
  HOLD: "border-violet/50 bg-violet/10 text-violet",
  REDUCE: "border-amber/50 bg-amber/10 text-amber",
  EXIT: "border-down/50 bg-down/10 text-down",
});

export function ActionDecisionCard({ decision, operationalState }: {
  readonly decision: ActionDecision | null;
  readonly operationalState?: OperationalTruthState | null;
}) {
  const truthLabel = operationalState?.status === "RESTORED_HISTORICAL"
    ? "RESTORED HISTORICAL PAPER ACTION"
    : operationalState?.status === "DEGRADED_PROVIDER_UNAVAILABLE"
      ? "LAST-KNOWN HISTORICAL PAPER ACTION"
      : "CANONICAL PAPER ACTION";
  const truthNotice = operationalState?.status === "RESTORED_HISTORICAL"
    ? "HISTORICAL / RESTORED · NOT CURRENT"
    : operationalState?.status === "DEGRADED_PROVIDER_UNAVAILABLE"
      ? "LAST-KNOWN · PROVIDER UNAVAILABLE · NOT CURRENT"
      : null;
  if (decision === null) {
    return (
      <section className="min-w-0 border border-amber/40 bg-amber/5 p-4" aria-label="Canonical paper action unavailable">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 shrink-0 text-amber" size={18} />
          <div className="min-w-0">
            <div className="font-mono text-[10px] font-bold tracking-[0.2em] text-amber">{truthLabel}</div>
            <div className="mt-1 text-lg font-semibold text-ink">Unavailable</div>
            <p className="mt-1 text-[11px] text-muted">
              Awaiting a canonical ActionDecision from the 1H paper replay. No action is inferred from market or macro data.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const view = presentActionDecision(decision);

  return (
    <section className="min-w-0 border border-line bg-panel p-4" aria-label={`${truthLabel} for ${view.assetId}`} data-action={view.action}>
      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr_1.35fr]">
        <div className="min-w-0">
          <div className="flex min-w-0 items-start gap-2 break-words font-mono text-[10px] font-bold tracking-[0.2em] text-muted">
            <Target size={14} className="text-cyan" /> {truthLabel} · {view.assetId}
          </div>
          {truthNotice ? <div className="mt-1 font-mono text-[10px] font-bold text-amber">{truthNotice}</div> : null}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className={clsx("border px-4 py-2 font-mono text-2xl font-black tracking-[0.14em]", ACTION_TONE[view.action])}>
              {view.action}
            </span>
            <div className="text-[10px] text-muted">
              <div className="font-mono">PRODUCT EXPLANATION ONLY</div>
              <div className={clsx("mt-1 font-semibold", view.failClosed ? "text-amber" : "text-up")}>
                {view.failClosed ? "FAIL-CLOSED EVIDENCE STATE" : "CANONICALLY DERIVED"}
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 font-mono sm:grid-cols-3">
            <WeightCell label="CURRENT" value={view.currentWeightLabel} />
            <WeightCell label="OMEGA TARGET" value={view.targetWeightLabel} />
            <WeightCell label="DELTA" value={view.deltaWeightLabel} />
          </div>

          <div className="mt-3 space-y-1 border-t border-line pt-3 font-mono text-[10px] text-muted">
            <div className="flex items-center gap-1.5"><Clock3 size={11} /> Decision: <span className="text-ink">{view.decisionTimeLabel}</span></div>
            <div className="pl-[17px]">As of: <span className="text-ink">{view.asOfLabel}</span></div>
            <div className="break-all pl-[17px]" title={view.semanticIdentity}>ID: {view.semanticIdentity}</div>
          </div>
        </div>

        <div className="min-w-0 border-l-0 border-line xl:border-l xl:pl-4">
          <div className="flex items-center gap-2 font-mono text-[10px] font-bold tracking-[0.16em] text-muted">
            <CheckCircle2 size={13} className="text-up" /> SUPPORTING EVIDENCE
          </div>
          <ul className="mt-2 space-y-2 text-[11px] text-ink">
            {view.reasons.map((reason) => <li key={reason.code} className="break-words">• {reason.label}</li>)}
          </ul>

          <div className="mt-4 font-mono text-[10px] font-bold tracking-[0.16em] text-muted">CONTRADICTIONS</div>
          {view.contradictions.length > 0 ? (
            <ul className="mt-2 space-y-2 text-[11px] text-amber">
              {view.contradictions.map((item) => <li key={item.code} className="break-words">• {item.label}</li>)}
            </ul>
          ) : <div className="mt-2 text-[11px] text-muted">None supplied by the canonical decision.</div>}

          {view.conditions.length > 0 ? (
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {view.conditions.map((condition) => (
                <div key={condition.label} className="border border-line bg-panel-2 px-2 py-1.5 text-[10px]">
                  <span className="text-muted">{condition.label}</span>{" "}
                  <strong className={condition.status === "PROVEN" ? "text-up" : "text-amber"}>{condition.status}</strong>
                  {condition.evidenceSemanticIdentities.length > 0 ? (
                    <div className="mt-1 break-words font-mono text-[9px] text-muted">{condition.evidenceSemanticIdentities.length} canonical evidence IDs</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="min-w-0 border-l-0 border-line xl:border-l xl:pl-4">
          <div className="flex items-center gap-2 font-mono text-[10px] font-bold tracking-[0.16em] text-muted">
            <Shield size={13} className="text-cyan" /> QUALITY & AUTHORITY
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 text-[10px] sm:grid-cols-2">
            <StatusCell label="DATA QUALITY" value={view.dataQualityStatus} alert={view.dataQualityStatus !== "LIVE_CANONICAL"} />
            <StatusCell label="TARGET" value={view.targetAuthorityStatus} alert={view.targetAuthorityStatus !== "BOUND_OMEGA_TARGET"} />
            <StatusCell label="PERMISSION" value={view.permissionStatus} alert={view.permissionStatus === "NOT_BOUND"} />
            <StatusCell label="RISK" value={view.riskStatus} alert={view.riskStatus === "NOT_BOUND"} />
            <StatusCell label="LIFECYCLE" value={view.lifecycleStatus ?? "UNAVAILABLE"} alert={view.lifecycleStatus === null || view.lifecycleStatus === "INVALID"} />
            <StatusCell label="DOMAIN" value="1H · PAPER" />
          </div>
          <p className="mt-3 border-t border-line pt-3 text-[10px] leading-relaxed text-muted">
            ActionDecision explains canonical state. Omega owns target weights; ExecutionEngine owns fills; this card has no trading controls.
          </p>
        </div>
      </div>
    </section>
  );
}

function WeightCell({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="border border-line bg-panel-2 px-2 py-2">
      <div className="text-[9px] font-bold tracking-[0.12em] text-muted">{label}</div>
      <div className="mt-1 text-sm font-bold text-ink">{value}</div>
    </div>
  );
}

function StatusCell({ label, value, alert = false }: { readonly label: string; readonly value: string; readonly alert?: boolean }) {
  return (
    <div className="border border-line bg-panel-2 px-2 py-2">
      <div className="font-mono text-[9px] font-bold tracking-[0.1em] text-muted">{label}</div>
      <div className={clsx("mt-1 break-words font-mono text-[9px] font-semibold", alert ? "text-amber" : "text-ink")}>{value}</div>
    </div>
  );
}
