import { lazy, Suspense } from "react";
import { FeedSync } from "@/components/FeedSync";
import { GlobalChatbot } from "@/components/GlobalChatbot";
import { ProductSurfaceBoundary } from "@/components/ProductSurfaceBoundary";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { useUiStore } from "@/stores/uiStore";
import { TradingLabView } from "@/views/TradingLabView";

const ChartView = lazy(() => import("@/views/ChartView").then((module) => ({ default: module.ChartView })));
const MacroViewV2 = lazy(() => import("@/views/MacroViewV2").then((module) => ({ default: module.MacroViewV2 })));
const ResearchRulesView = lazy(() => import("@/views/ResearchRulesView").then((module) => ({ default: module.ResearchRulesView })));

const VIEW_NAME = {
  macro: "Macro",
  charts: "Charts",
  lab: "Paper Action",
  research: "Research / Rules",
} as const;

function ViewLoadingState() {
  return (
    <div className="flex h-full min-h-[240px] items-center justify-center bg-[#07090d] p-4" role="status">
      <span className="font-mono text-[11px] tracking-[0.16em] text-cyan">LOADING PRODUCT VIEW…</span>
    </div>
  );
}

export default function App() {
  const view = useUiStore((s) => s.view);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-terminal text-ink md:flex-row">
      <FeedSync />
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Header />
        <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          <ProductSurfaceBoundary key={view} surfaceName={VIEW_NAME[view]}>
            <Suspense fallback={<ViewLoadingState />}>
              {view === "macro" ? <MacroViewV2 /> : null}
              {view === "charts" ? <ChartView /> : null}
              {view === "lab" ? <TradingLabView /> : null}
              {view === "research" ? <ResearchRulesView /> : null}
            </Suspense>
          </ProductSurfaceBoundary>
          <div className="scanlines absolute inset-0 pointer-events-none" />
        </main>
      </div>
      <GlobalChatbot />
    </div>
  );
}
