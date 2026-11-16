import type { AggressivenessState, Direction, TradingRegime } from "../types.ts";

export type HftOrderTrigger = {
  trigger: boolean;
  side: Direction;
  orderType: "LIMIT" | "MARKET";
  price: number;
  expectedMicroMove: number;
  imbalance: number;
  momentumScore: number;
  thesis: string;
};

export class StrategistAgent {
  /**
   * Evaluates High-Frequency Barrage entry triggers based on
   * Level 2 Orderbook Imbalance and 1-tick momentum.
   */
  static evaluateHftBarrageEntry(
    symbol: string,
    bestBid: number,
    bestAsk: number,
    orderbookImbalance: number,
    ofiZScore: number,
    atr1m: number,
    aggressiveness: AggressivenessState,
    regime: TradingRegime = "standard",
    momentumHint = 0,
  ): HftOrderTrigger | null {
    const isKamikaze = regime === "hft_kamikaze" || aggressiveness === "lagging_aggressive";
    if (!isKamikaze) {
      return null;
    }

    const midPrice = (bestBid + bestAsk) / 2;
    const expectedMicroMove = atr1m > 0 ? atr1m * 0.2 : midPrice * 0.0005;

    // Combined momentum from L2 orderbook imbalance (-1 to +1), OFI Z-score, and 1-tick/short-term price drift
    const driftSignal = Math.tanh(momentumHint * 120);
    const momentum = orderbookImbalance * 0.5 + Math.tanh(ofiZScore) * 0.35 + driftSignal * 0.35;

    // Long trigger: bid wall / positive imbalance / upward momentum
    if (orderbookImbalance > 0.12 || ofiZScore > 0.8 || momentum > 0.05) {
      return {
        trigger: true,
        side: "long",
        orderType: "LIMIT",
        price: Number(bestBid.toFixed(4)),
        expectedMicroMove,
        imbalance: orderbookImbalance,
        momentumScore: Number(momentum.toFixed(3)),
        thesis: `[HFT KAMIKAZE BARRAGE] Flux haussier sur ${symbol} (L2=${(orderbookImbalance * 100).toFixed(1)}%, OFI Z=${ofiZScore.toFixed(2)}, Mom=${momentum.toFixed(2)}) -> Tir d'ordre rapide LONG @ ${bestBid}.`,
      };
    }

    // Short trigger: ask wall / negative imbalance / downward momentum
    if (orderbookImbalance < -0.12 || ofiZScore < -0.8 || momentum < -0.05) {
      return {
        trigger: true,
        side: "short",
        orderType: "LIMIT",
        price: Number(bestAsk.toFixed(4)),
        expectedMicroMove,
        imbalance: orderbookImbalance,
        momentumScore: Number(momentum.toFixed(3)),
        thesis: `[HFT KAMIKAZE BARRAGE] Flux baissier sur ${symbol} (L2=${(orderbookImbalance * 100).toFixed(1)}%, OFI Z=${ofiZScore.toFixed(2)}, Mom=${momentum.toFixed(2)}) -> Tir d'ordre rapide SHORT @ ${bestAsk}.`,
      };
    }

    return null;
  }
}
