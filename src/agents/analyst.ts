import type { Direction, MacroWebhookPayload, SocialSentimentSample } from "../types.ts";

export type MacroAnalysisResult = {
  symbol: string;
  macroScore: number; // -1 (bearish) to +1 (bullish)
  macroComponent: number;
  sentimentComponent: number;
  reason: string;
};

export class MarketAnalystAgent {
  /**
   * Parses macro-economic JSON feeds and social/Twitter sentiment scores
   * to assign a normalized MacroScore in [-1, +1] per symbol.
   */
  static computeMacroScore(
    symbol: string,
    macroEvents: MacroWebhookPayload[] = [],
    socialSentiment: Record<string, SocialSentimentSample> = {},
    now = Date.now(),
  ): MacroAnalysisResult {
    // 1. Macro-economic surprise component (recent 24h events)
    const recentMacro = macroEvents.filter((e) => now - e.timestamp <= 24 * 3600_000);
    let macroWeighted = 0;
    let macroWeightSum = 0;

    for (const ev of recentMacro) {
      const impactW = ev.impact === "HIGH" ? 1.0 : ev.impact === "MED" ? 0.6 : 0.25;
      const surprise =
        ev.surpriseIndex !== undefined
          ? Math.max(-1, Math.min(1, ev.surpriseIndex))
          : ev.forecast !== 0
            ? Math.max(-1, Math.min(1, (ev.actual - ev.forecast) / Math.max(Math.abs(ev.forecast), 1e-6)))
            : 0;

      // For USD-quoted pairs (EURUSD, GBPUSD, XAUUSD, BTCUSDT), positive US macro surprise strengthens USD (bearish quote)
      const upper = symbol.toUpperCase();
      const directionalSign = upper.startsWith("USD") ? 1 : -1;
      macroWeighted += surprise * directionalSign * impactW;
      macroWeightSum += impactW;
    }

    const macroComponent = macroWeightSum > 0 ? Math.max(-1, Math.min(1, macroWeighted / macroWeightSum)) : 0;

    // 2. Twitter / Social sentiment component
    const sample = socialSentiment[symbol] ?? socialSentiment[symbol.replace(/USDT$|USD$/i, "")];
    const sentimentComponent =
      sample && now - sample.updatedAt <= 6 * 3600_000
        ? Math.max(-1, Math.min(1, sample.score * Math.min(1.5, Math.max(0.5, sample.authorityWeight || 1))))
        : 0;

    const macroScore = Number(
      Math.max(-1, Math.min(1, macroComponent * 0.6 + sentimentComponent * 0.4)).toFixed(3),
    );

    return {
      symbol,
      macroScore,
      macroComponent: Number(macroComponent.toFixed(3)),
      sentimentComponent: Number(sentimentComponent.toFixed(3)),
      reason: `MacroScore(${symbol})=${macroScore >= 0 ? "+" : ""}${macroScore} [Macro=${macroComponent.toFixed(2)}, Social=${sentimentComponent.toFixed(2)}]`,
    };
  }

  /**
   * Filters out trades that fight a strong fundamental macro trend.
   */
  static allowsDirection(direction: Direction, macroScore: number, threshold = 0.45): boolean {
    if (direction === "long" && macroScore <= -threshold) return false;
    if (direction === "short" && macroScore >= threshold) return false;
    return true;
  }
}
