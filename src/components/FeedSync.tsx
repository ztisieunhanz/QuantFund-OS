import { useEffect } from "react";
import { useMarketStore } from "@/stores/marketStore";

export function FeedSync() {
  const loadMarket = useMarketStore((s) => s.load);

  useEffect(() => {
    void loadMarket();
    const marketId = window.setInterval(() => {
      void loadMarket();
    }, 20_000);
    return () => {
      window.clearInterval(marketId);
    };
  }, [loadMarket]);

  return null;
}
