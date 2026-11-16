import type React from "react";
import type { DeskState, TradingRegime } from "../types.ts";
import { Header } from "./Header.tsx";
import { Desk3D } from "./Desk3D.tsx";
import { Charts } from "./Charts.tsx";
import { Salon, type SalonChannel } from "./Salon.tsx";
import { NotionJournal, type EquityTimeframe } from "./NotionJournal.tsx";

export interface AppProps {
  state: DeskState;
  activeTab: "desk" | "charts" | "chat" | "journal";
  salonChannel: SalonChannel;
  equityTimeframe: EquityTimeframe;
  onRegimeChange: (r: TradingRegime) => void;
  onSelectChannel: (ch: SalonChannel) => void;
  onSelectTimeframe: (tf: EquityTimeframe) => void;
  onCloseAll: () => void;
  onToggleHalt: () => void;
}

export const App: React.FC<AppProps> = ({
  state,
  activeTab,
  salonChannel,
  equityTimeframe,
  onRegimeChange,
  onSelectChannel,
  onSelectTimeframe,
  onCloseAll,
  onToggleHalt,
}) => {
  const closedTrades = state.tickets.filter((t) => t.status === "closed");
  const openPositions = state.tickets.filter((t) => t.status === "open");
  const lastCurve = state.curve[state.curve.length - 1];
  const equity = state.mt5Live?.connected ? state.mt5Live.equity : (lastCurve?.eq ?? state.startEquity);
  const currentPnl = state.mt5Live?.connected
    ? state.mt5Live.profit
    : openPositions.reduce((s, t) => s + (t.mt5Profit ?? t.pnl ?? 0), 0);

  const dayStart = new Date().setHours(0, 0, 0, 0);
  const dailyClosedProfit = closedTrades
    .filter((t) => (t.closedAt ?? 0) >= dayStart)
    .reduce((s, t) => s + (t.pnl ?? 0), 0);

  return (
    <div className="relative min-h-screen w-full bg-[#050811] text-neutral-100">
      <Header
        currentRegime={state.settings.regime ?? "standard"}
        onRegimeChange={onRegimeChange}
        equity={equity}
        currentPnl={currentPnl}
        dailyClosedProfit={dailyClosedProfit}
        halted={state.halted}
        onCloseAll={onCloseAll}
        onToggleHalt={onToggleHalt}
      />
      {activeTab === "desk" && (
        <Desk3D
          activities={state.activities}
          pulses={state.pulses}
          equity={equity}
          currentPnl={currentPnl}
          dailyClosedProfit={dailyClosedProfit}
        />
      )}
      {activeTab === "charts" && <Charts symbol={state.settings.symbols[0] ?? "BTCUSDT"} />}
      {activeTab === "chat" && (
        <Salon messages={state.messages} activeChannel={salonChannel} onSelectChannel={onSelectChannel} />
      )}
      {activeTab === "journal" && (
        <NotionJournal
          startEquity={state.startEquity}
          closedTrades={closedTrades}
          openPositions={openPositions}
          curve={state.curve}
          timeframe={equityTimeframe}
          onSelectTimeframe={onSelectTimeframe}
        />
      )}
    </div>
  );
};

export default App;
