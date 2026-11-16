import type { AggressivenessState, TradingRegime } from "../types.ts";

export type HftSizingResult = {
  ok: boolean;
  targetFiatProfit: number;
  expectedPriceMove: number;
  expectedPriceMovePct: number;
  requiredNotional: number;
  leverage: number;
  requiredMargin: number;
  lotSize: number;
  liquidationPrice: number;
  reason?: string;
};

export class RiskManagerAgent {
  /**
   * Dynamically calculates maximum concurrent trades based on available margin,
   * volatility, aggressiveness, and regime.
   */
  static calculateDynamicConcurrency(
    availableMargin: number,
    totalEquity: number,
    volatility: number,
    aggressiveness: AggressivenessState,
    regime: TradingRegime = "standard",
  ): number {
    if (regime === "hft_kamikaze" || aggressiveness === "lagging_aggressive") {
      // In High Aggressiveness / Kamikaze mode, allow up to 50 simultaneous micro-positions
      // provided liquidation threshold and margin headroom are maintained.
      const marginPerPosition = Math.max(20, totalEquity * 0.005);
      const marginCapacity = Math.floor((availableMargin * 0.85) / marginPerPosition);
      return Math.min(50, Math.max(10, marginCapacity));
    }

    if (aggressiveness === "target_reached" || aggressiveness === "secured") {
      // Reduce risk once goal is achieved or deadline met
      return 1;
    }

    // Standard regime
    const baseConcurrency = totalEquity >= 50_000 ? 5 : 3;
    const volAdjustment = volatility > 0.03 ? -1 : volatility < 0.01 ? 1 : 0;
    return Math.max(2, Math.min(8, baseConcurrency + volAdjustment));
  }

  /**
   * Reverse-Engineered Position Sizing for "HFT FIAT-TARGET SCALPER"
   *
   * Formula:
   * expectedPriceMove = AverageTrueRange(1m) * 0.2 (micro-move)
   * requiredNotional = TargetFiatProfit / (expectedPriceMove / currentPrice)
   * Leverage = up to 500x to minimize required margin
   */
  static reverseEngineerHftSizing(
    currentPrice: number,
    atr1m: number,
    targetFiatProfit = 75, // Midpoint between $50 and $100
    side: "long" | "short" = "long",
    maxLeverage = 500,
    availableMargin = 10_000,
  ): HftSizingResult {
    const price = Math.max(currentPrice, 1e-6);

    // Micro-move expected: 0.2 * ATR(1m), with fallback to 0.05% of price
    const expectedPriceMove = atr1m > 0 ? atr1m * 0.2 : price * 0.0005;
    const expectedPriceMovePct = expectedPriceMove / price;

    if (expectedPriceMovePct <= 1e-6) {
      return {
        ok: false,
        targetFiatProfit,
        expectedPriceMove,
        expectedPriceMovePct,
        requiredNotional: 0,
        leverage: 1,
        requiredMargin: 0,
        lotSize: 0,
        liquidationPrice: 0,
        reason: "Micro-mouvement estimé quasi nul, impossible d'extraire la cible.",
      };
    }

    // Required notional to yield targetFiatProfit on this micro-move
    const rawRequiredNotional = targetFiatProfit / expectedPriceMovePct;

    // Apply high leverage (up to 500x)
    const appliedLeverage = Math.max(1, Math.min(500, maxLeverage));
    let requiredMargin = rawRequiredNotional / appliedLeverage;

    let finalNotional = rawRequiredNotional;
    if (requiredMargin > availableMargin * 0.9) {
      // Scale down if available margin is tight
      requiredMargin = availableMargin * 0.9;
      finalNotional = requiredMargin * appliedLeverage;
    }

    const lotSize = Number((finalNotional / price).toFixed(6));

    // Liquidation price calculation with 0.5% maintenance margin
    const mmr = Math.min(0.005, (1 / appliedLeverage) * 0.35);
    const liquidationPrice =
      side === "long"
        ? price * (1 - 1 / appliedLeverage + mmr)
        : price * (1 + 1 / appliedLeverage - mmr);

    return {
      ok: true,
      targetFiatProfit,
      expectedPriceMove,
      expectedPriceMovePct,
      requiredNotional: Number(finalNotional.toFixed(2)),
      leverage: appliedLeverage,
      requiredMargin: Number(requiredMargin.toFixed(2)),
      lotSize,
      liquidationPrice: Number(liquidationPrice.toFixed(4)),
    };
  }

  /**
   * Kelly Criterion modified for HFT micro-edges with alpha decay scaling.
   */
  static computeModifiedHftKelly(
    winRate: number,
    payoffRatio: number,
    alphaDecayMultiplier = 1.0,
    maxRiskPct = 0.03,
  ): number {
    const p = Math.max(0.25, Math.min(0.85, winRate));
    const b = Math.max(1.05, payoffRatio);
    const fullKelly = Math.max(0.005, (p * b - (1 - p)) / b);
    const fractionalHftKelly = fullKelly * 0.25 * alphaDecayMultiplier;
    return Number(Math.max(0.002, Math.min(maxRiskPct, fractionalHftKelly)).toFixed(5));
  }

  /**
   * Strictly verifies that the Liquidation Price is at least 15% further
   * from entry than the Stop-Loss price.
   */
  static verifyLiquidationBuffer15Pct(
    entryPrice: number,
    stopLossPrice: number,
    leverage: number,
    side: "long" | "short",
    maintenanceMarginRate = 0.005,
  ): { safe: boolean; liqPrice: number; bufferRatio: number } {
    const lev = Math.max(1, Math.min(500, leverage));
    const mmr = Math.min(maintenanceMarginRate, (1 / lev) * 0.35);
    const liqPrice =
      side === "long"
        ? entryPrice * (1 - 1 / lev + mmr)
        : entryPrice * (1 + 1 / lev - mmr);
    const liqDist = Math.abs(entryPrice - liqPrice);
    if (liqDist <= 1e-9) {
      return { safe: false, liqPrice, bufferRatio: 0 };
    }
    if (side === "long") {
      if (stopLossPrice <= liqPrice) return { safe: false, liqPrice, bufferRatio: 0 };
      const ratio = (stopLossPrice - liqPrice) / liqDist;
      return { safe: ratio >= 0.15, liqPrice, bufferRatio: Number(ratio.toFixed(4)) };
    }
    if (stopLossPrice >= liqPrice) return { safe: false, liqPrice, bufferRatio: 0 };
    const ratio = (liqPrice - stopLossPrice) / liqDist;
    return { safe: ratio >= 0.15, liqPrice, bufferRatio: Number(ratio.toFixed(4)) };
  }
}
