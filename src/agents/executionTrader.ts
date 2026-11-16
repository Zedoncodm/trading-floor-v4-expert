import type { Ticket } from "../types.ts";

export class ExecutionTraderAgent {
  /**
   * High-frequency Fiat-Target Take Profit Evaluator
   *
   * Completely ignores technical R-multiples or chart-based targets.
   * Checks if unrealized PnL is between $50 and $100 (or >= $50),
   * and signals an immediate market close.
   */
  static evaluateFiatTargetTakeProfit(
    ticket: Ticket,
    currentPrice: number,
    minTargetFiat = 50,
    maxTargetFiat = 100,
  ): {
    shouldClose: boolean;
    unrealizedPnl: number;
    reason?: string;
  } {
    let unrealizedPnl = 0;
    if (ticket.mt5Profit !== undefined && Number.isFinite(ticket.mt5Profit)) {
      unrealizedPnl = ticket.mt5Profit;
    } else {
      const fillPx = ticket.fillPrice ?? ticket.entry;
      if (!fillPx || fillPx <= 0) {
        return { shouldClose: false, unrealizedPnl: 0 };
      }

      const isLong = ticket.direction === "long";
      const priceDiff = isLong ? currentPrice - fillPx : fillPx - currentPrice;
      const priceMoveRatio = priceDiff / fillPx;
      unrealizedPnl = ticket.notional * priceMoveRatio - (ticket.fees || 0);
    }

    // TRIGGER: If unrealizedPnL is in the $50-$100 target band (or above $50)
    if (unrealizedPnl >= minTargetFiat) {
      return {
        shouldClose: true,
        unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
        reason: `[HFT FIAT-TARGET REACHED] Cible ${minTargetFiat}$ - ${maxTargetFiat}$ atteinte (+${unrealizedPnl.toFixed(2)}$). Sortie immédiate au marché.`,
      };
    }

    return {
      shouldClose: false,
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
    };
  }

  /**
   * TWAP / VWAP Slicing planner for large non-HFT orders.
   * For HFT Fiat-Target ($50-$100), uses instant single Market Orders.
   */
  static planTwapVwapSlices(
    totalNotional: number,
    isHftFiatTarget: boolean,
    maxSingleSliceUsd = 100_000,
    maxSlices = 6,
  ): { mode: "INSTANT_MARKET" | "TWAP_VWAP"; slices: number; sliceNotional: number; intervalMs: number } {
    if (isHftFiatTarget || totalNotional <= maxSingleSliceUsd) {
      return {
        mode: "INSTANT_MARKET",
        slices: 1,
        sliceNotional: Number(totalNotional.toFixed(2)),
        intervalMs: 0,
      };
    }
    const slices = Math.min(maxSlices, Math.max(2, Math.ceil(totalNotional / maxSingleSliceUsd)));
    return {
      mode: "TWAP_VWAP",
      slices,
      sliceNotional: Number((totalNotional / slices).toFixed(2)),
      intervalMs: 15_000,
    };
  }
}
