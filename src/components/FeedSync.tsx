import { useEffect } from "react";
import { useMarketStore } from "@/stores/marketStore";
import { useMacroStore } from "@/stores/macroStore";

export function FeedSync() {
  const loadMarket = useMarketStore((s) => s.load);
  const loadMacro = useMacroStore((s) => s.load);

  useEffect(() => {
    void loadMacro();
    void loadMarket();
    const marketId = window.setInterval(() => {
      void loadMarket();
    }, 20_000);
    const macroId = window.setInterval(() => {
      void loadMacro();
    }, 120_000);
    return () => {
      window.clearInterval(marketId);
      window.clearInterval(macroId);
    };
  }, [loadMacro, loadMarket]);

  return null;
}
