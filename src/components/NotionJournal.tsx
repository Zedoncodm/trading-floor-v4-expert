import type React from "react";
import type { EquityPoint, Ticket } from "../types.ts";

export type EquityTimeframe = "1D" | "1W" | "1M" | "ALL";

export interface NotionJournalProps {
  startEquity: number;
  closedTrades: Ticket[];
  openPositions: Ticket[];
  curve: EquityPoint[];
  timeframe: EquityTimeframe;
  onSelectTimeframe: (tf: EquityTimeframe) => void;
}

export function buildCumulativeEquitySeries(
  startEquity: number,
  closedTrades: Ticket[],
  openPositions: Ticket[],
  timeframe: EquityTimeframe,
  now = Date.now(),
): Array<{ time: number; value: number }> {
  const cutoff =
    timeframe === "1D"
      ? now - 86_400_000
      : timeframe === "1W"
        ? now - 7 * 86_400_000
        : timeframe === "1M"
          ? now - 30 * 86_400_000
          : 0;

  const sortedClosed = [...closedTrades]
    .filter((t) => (t.closedAt ?? t.createdAt) >= cutoff)
    .sort((a, b) => (a.closedAt ?? a.createdAt) - (b.closedAt ?? b.createdAt));

  let runningEq = startEquity;
  const pts: Array<{ time: number; value: number }> = [];
  for (const t of sortedClosed) {
    runningEq += t.pnl ?? 0;
    pts.push({
      time: Math.floor((t.closedAt ?? t.createdAt) / 1000),
      value: Number(runningEq.toFixed(2)),
    });
  }

  const openUnrealized = openPositions.reduce((s, t) => s + (t.mt5Profit ?? t.pnl ?? 0), 0);
  pts.push({
    time: Math.floor(now / 1000),
    value: Number((runningEq + openUnrealized).toFixed(2)),
  });

  return pts;
}

export const NotionJournal: React.FC<NotionJournalProps> = ({
  startEquity,
  closedTrades,
  openPositions,
  timeframe,
  onSelectTimeframe,
}) => {
  const series = buildCumulativeEquitySeries(startEquity, closedTrades, openPositions, timeframe);

  return (
    <div className="p-6 mt-16 bg-[#050811] text-neutral-100 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-mono font-bold uppercase tracking-wider text-neutral-200">
          Courbe d&apos;Équité Cumulée ({series.length} points)
        </h2>
        <div className="flex gap-2">
          {(["1D", "1W", "1M", "ALL"] as EquityTimeframe[]).map((tf) => (
            <button
              key={tf}
              type="button"
              onClick={() => onSelectTimeframe(tf)}
              className={`px-3 py-1 rounded-lg text-xs font-mono font-bold border ${
                timeframe === tf
                  ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300"
                  : "bg-neutral-900 border-neutral-800 text-neutral-400"
              }`}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>
      <div id="journal-equity-area" data-points={series.length} className="h-72 w-full rounded-2xl border border-neutral-800 bg-neutral-950/60" />
    </div>
  );
};

export default NotionJournal;
