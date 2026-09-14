import { FeedSync } from "@/components/FeedSync";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { useUiStore } from "@/stores/uiStore";
import { ChartView } from "@/views/ChartView";
import { MacroView } from "@/views/MacroView";
import { TradingLabView } from "@/views/TradingLabView";

export default function App() {
  const view = useUiStore((s) => s.view);

  return (
    <div className="flex h-full bg-terminal text-ink relative">
      <FeedSync />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="relative min-h-0 flex-1">
          {view === "macro" ? <MacroView /> : null}
          {view === "charts" ? <ChartView /> : null}
          {view === "lab" ? <TradingLabView /> : null}
          <div className="scanlines absolute inset-0 pointer-events-none" />
        </main>
      </div>
    </div>
  );
}