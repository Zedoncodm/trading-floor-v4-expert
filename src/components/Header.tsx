import type React from "react";
import type { TradingRegime } from "../types.ts";

export interface HeaderProps {
  currentRegime: TradingRegime;
  onRegimeChange: (regime: TradingRegime) => void;
  equity: number;
  currentPnl: number;
  dailyClosedProfit: number;
  halted: boolean;
  onCloseAll: () => void;
  onToggleHalt: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentRegime,
  onRegimeChange,
  equity,
  currentPnl,
  dailyClosedProfit,
  halted,
  onCloseAll,
  onToggleHalt,
}) => {
  const isKamikaze = currentRegime === "hft_kamikaze";

  return (
    <header className="opacity-0 hover:opacity-100 transition-opacity duration-300 absolute top-0 z-50 w-full flex items-center justify-between px-6 py-3 bg-neutral-950/85 backdrop-blur-xl border-b border-neutral-800/80">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs font-mono font-bold tracking-widest text-neutral-100 uppercase">
            Trading Floor V5
          </span>
        </div>

        <select
          aria-label="Régime actif"
          value={currentRegime}
          onChange={(e: any) => onRegimeChange(e.target.value as TradingRegime)}
          className={`text-xs font-mono font-bold px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
            isKamikaze
              ? "bg-red-950/70 border-red-500/80 text-red-200 shadow-[0_0_12px_rgba(239,68,68,0.4)]"
              : "bg-neutral-900 border-neutral-700 text-neutral-200 hover:border-neutral-500"
          }`}
        >
          <option value="standard">Standard (WFO/GRPO)</option>
          <option value="macro_fvg">Macro FVG</option>
          <option value="hft_kamikaze">HFT FIAT-TARGET (KAMIKAZE)</option>
        </select>
      </div>

      <div className="flex items-center gap-5">
        <div className="text-right">
          <div className="text-[10px] font-mono text-neutral-400 uppercase">Équité Totale</div>
          <div className="text-sm font-mono font-bold text-neutral-100">
            {equity.toLocaleString("fr-FR", { style: "currency", currency: "USD" })}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-mono text-neutral-400 uppercase">PNL Actuel</div>
          <div className={`text-sm font-mono font-bold ${currentPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {currentPnl >= 0 ? "+" : ""}
            {currentPnl.toLocaleString("fr-FR", { style: "currency", currency: "USD" })}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-mono text-neutral-400 uppercase">Profit Fermé de la journée</div>
          <div className={`text-sm font-mono font-bold ${dailyClosedProfit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {dailyClosedProfit >= 0 ? "+" : ""}
            {dailyClosedProfit.toLocaleString("fr-FR", { style: "currency", currency: "USD" })}
          </div>
        </div>

        <div className="flex items-center gap-2 pl-4 border-l border-neutral-800">
          <button
            type="button"
            onClick={onCloseAll}
            className="px-2.5 py-1 rounded text-[11px] font-mono font-extrabold bg-red-600 hover:bg-red-500 text-white shadow-md transition-colors"
          >
            CLOSE ALL
          </button>
          <button
            type="button"
            onClick={onToggleHalt}
            className="px-2.5 py-1 rounded text-[11px] font-mono font-extrabold bg-yellow-400 hover:bg-yellow-300 text-black shadow-md transition-colors"
          >
            {halted ? "RESUME" : "HALT"}
          </button>
        </div>
      </div>
    </header>
  );
};

export default Header;
