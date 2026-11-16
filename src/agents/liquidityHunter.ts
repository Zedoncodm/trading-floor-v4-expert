import type {
  Kline,
  LiquidityHunterTelemetry,
  LiquidityMagnetZone,
  SpoofingAlert,
} from "../types.ts";

type TrackedWall = {
  symbol: string;
  side: "BID" | "ASK";
  price: number;
  size: number;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type SqueezeSignal = {
  signal: "HIGH_PROBABILITY_LONG_SQUEEZE" | "HIGH_PROBABILITY_SHORT_SQUEEZE";
  probability: number;
  bias: "long" | "short";
};

export class LiquidityHunterAgent {
  private readonly largeWalls = new Map<string, TrackedWall>();
  private readonly spoofingAlerts: SpoofingAlert[] = [];
  private latestTelemetry: LiquidityHunterTelemetry = {
    symbol: "BTCUSDT",
    imbalance: 0,
    bidWallUsd: 0,
    askWallUsd: 0,
    heatBars: [0.25, 0.35, 0.45, 0.55, 0.55, 0.45, 0.35, 0.25],
    spoofingAlerts: [],
    squeezeSignal: null,
    squeezeProbability: 0,
    liquidityMagnetZones: [],
    updatedAt: Date.now(),
  };

  private wallKey(symbol: string, side: "BID" | "ASK", price: number, midPrice: number): string {
    const step = Math.max(midPrice * 0.0005, 1e-6);
    const bucket = Math.round(price / step) * step;
    return `${symbol}:${side}:${bucket.toFixed(6)}`;
  }

  analyzeOrderBook(
    symbol: string,
    midPrice: number,
    bids: [number, number][],
    asks: [number, number][],
    avgVolume: number,
    now = Date.now(),
  ): {
    imbalance: number;
    bidWallUsd: number;
    askWallUsd: number;
    heatBars: number[];
    newSpoofs: SpoofingAlert[];
  } {
    const ref = Math.max(midPrice, 1e-9);
    const maxBand = ref * 0.01;
    const avgVol = Math.max(avgVolume, 1e-9);

    let bidQty = 0;
    let askQty = 0;
    let bidWallUsd = 0;
    let askWallUsd = 0;
    const seenKeys = new Set<string>();
    const bidBins = [0, 0, 0, 0];
    const askBins = [0, 0, 0, 0];

    for (const [px, qty] of bids) {
      const dist = ref - px;
      if (dist < 0 || dist > maxBand) continue;
      bidQty += qty;
      bidWallUsd += px * qty;
      const bIdx = Math.min(3, Math.floor((dist / maxBand) * 4));
      bidBins[3 - bIdx] += qty;

      if (qty > 50 * avgVol) {
        const key = this.wallKey(symbol, "BID", px, ref);
        seenKeys.add(key);
        const existing = this.largeWalls.get(key);
        this.largeWalls.set(key, {
          symbol,
          side: "BID",
          price: px,
          size: qty,
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSeenAt: now,
        });
      }
    }

    for (const [px, qty] of asks) {
      const dist = px - ref;
      if (dist < 0 || dist > maxBand) continue;
      askQty += qty;
      askWallUsd += px * qty;
      const aIdx = Math.min(3, Math.floor((dist / maxBand) * 4));
      askBins[aIdx] += qty;

      if (qty > 50 * avgVol) {
        const key = this.wallKey(symbol, "ASK", px, ref);
        seenKeys.add(key);
        const existing = this.largeWalls.get(key);
        this.largeWalls.set(key, {
          symbol,
          side: "ASK",
          price: px,
          size: qty,
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSeenAt: now,
        });
      }
    }

    // Check walls that vanished <= 500ms without a fill (price did not trade through wall)
    const newSpoofs: SpoofingAlert[] = [];
    for (const [key, w] of this.largeWalls.entries()) {
      if (w.symbol !== symbol) continue;
      if (!seenKeys.has(key)) {
        const lifespan = now - w.firstSeenAt;
        const untouched = w.side === "BID" ? ref > w.price : ref < w.price;
        if (lifespan <= 500 && untouched) {
          const alert: SpoofingAlert = {
            symbol,
            side: w.side,
            price: w.price,
            wallSize: w.size,
            durationMs: Math.max(1, lifespan),
            at: now,
          };
          newSpoofs.push(alert);
          this.spoofingAlerts.unshift(alert);
        }
        this.largeWalls.delete(key);
      }
    }
    if (this.spoofingAlerts.length > 30) {
      this.spoofingAlerts.length = 30;
    }

    const total = bidQty + askQty;
    const imbalance = total > 0 ? Math.max(-1, Math.min(1, (bidQty - askQty) / total)) : 0;
    const combined = [...bidBins, ...askBins];
    const maxBin = Math.max(1e-9, ...combined);
    const heatBars = combined.map((v) => Number(Math.min(1, Math.max(0.08, v / maxBin)).toFixed(3)));

    this.latestTelemetry = {
      ...this.latestTelemetry,
      symbol,
      imbalance: Number(imbalance.toFixed(4)),
      bidWallUsd: Number(bidWallUsd.toFixed(2)),
      askWallUsd: Number(askWallUsd.toFixed(2)),
      heatBars,
      spoofingAlerts: [...this.spoofingAlerts],
      updatedAt: now,
    };

    return { imbalance, bidWallUsd, askWallUsd, heatBars, newSpoofs };
  }

  isSpoofedLevel(symbol: string, price: number, now = Date.now()): boolean {
    const tol = Math.max(price * 0.0025, 1e-6);
    return this.spoofingAlerts.some(
      (a) => a.symbol === symbol && now - a.at <= 120_000 && Math.abs(a.price - price) <= tol,
    );
  }

  computeSqueezeSignal(fundingRate: number, oiChange1h: number, ret1h: number): SqueezeSignal | null {
    const stagnantPrice = Math.abs(ret1h) < 0.003;
    if (fundingRate > 0.0001 && oiChange1h > 0 && stagnantPrice) {
      const prob = Math.min(0.95, 0.62 + Math.min(0.2, fundingRate * 300) + Math.min(0.13, oiChange1h * 2));
      return {
        signal: "HIGH_PROBABILITY_LONG_SQUEEZE",
        probability: Number(prob.toFixed(3)),
        bias: "short",
      };
    }
    if (fundingRate < -0.0001 && oiChange1h > 0 && stagnantPrice) {
      const prob = Math.min(0.95, 0.62 + Math.min(0.2, Math.abs(fundingRate) * 300) + Math.min(0.13, oiChange1h * 2));
      return {
        signal: "HIGH_PROBABILITY_SHORT_SQUEEZE",
        probability: Number(prob.toFixed(3)),
        bias: "long",
      };
    }
    return null;
  }

  computeLiquidityMagnetZones(bars: Kline[], refPrice: number, symbol = "BTCUSDT"): LiquidityMagnetZone[] {
    if (!bars || bars.length < 15) return [];
    const recent = bars.slice(-80);
    const meanVol = recent.reduce((s, b) => s + Math.max(1, b.volume), 0) / recent.length;
    const zones: LiquidityMagnetZone[] = [];

    for (let i = 2; i < recent.length - 2; i++) {
      const b = recent[i];
      const isSwingHigh =
        b.high > recent[i - 1].high &&
        b.high > recent[i - 2].high &&
        b.high > recent[i + 1].high &&
        b.high > recent[i + 2].high;
      const isSwingLow =
        b.low < recent[i - 1].low &&
        b.low < recent[i - 2].low &&
        b.low < recent[i + 1].low &&
        b.low < recent[i + 2].low;
      const volWeight = Math.min(3.0, Math.max(0.4, b.volume / Math.max(1, meanVol)));

      if (isSwingHigh && !this.isSpoofedLevel(symbol, b.high)) {
        const distPenalty = 1 / (1 + Math.abs(b.high - refPrice) / Math.max(1e-9, refPrice * 0.04));
        zones.push({
          price: Number(b.high.toFixed(6)),
          weight: Number((volWeight * distPenalty).toFixed(4)),
          side: "SHORT_LIQ",
        });
      }
      if (isSwingLow && !this.isSpoofedLevel(symbol, b.low)) {
        const distPenalty = 1 / (1 + Math.abs(b.low - refPrice) / Math.max(1e-9, refPrice * 0.04));
        zones.push({
          price: Number(b.low.toFixed(6)),
          weight: Number((volWeight * distPenalty).toFixed(4)),
          side: "LONG_LIQ",
        });
      }
    }

    zones.sort((a, b) => b.weight - a.weight);
    return zones.slice(0, 8);
  }

  updateSnapshotSummary(input: {
    symbol: string;
    midPrice: number;
    bids: [number, number][];
    asks: [number, number][];
    bars: Kline[];
    fundingRate: number;
    oiChange1h: number;
    ret1h: number;
    now?: number;
  }): {
    squeeze: SqueezeSignal | null;
    zones: LiquidityMagnetZone[];
    newSpoofs: SpoofingAlert[];
    telemetry: LiquidityHunterTelemetry;
  } {
    const now = input.now ?? Date.now();
    const recentBars = input.bars.slice(-20);
    const avgBarVol = recentBars.length
      ? recentBars.reduce((s, b) => s + Math.max(1, b.volume), 0) / recentBars.length
      : 100;
    const avgLevelVol = Math.max(1e-4, avgBarVol / 200);
    const book = this.analyzeOrderBook(input.symbol, input.midPrice, input.bids, input.asks, avgLevelVol, now);
    const squeeze = this.computeSqueezeSignal(input.fundingRate, input.oiChange1h, input.ret1h);
    const zones = this.computeLiquidityMagnetZones(input.bars, input.midPrice, input.symbol);

    this.latestTelemetry = {
      symbol: input.symbol,
      imbalance: book.imbalance,
      bidWallUsd: book.bidWallUsd,
      askWallUsd: book.askWallUsd,
      heatBars: book.heatBars,
      spoofingAlerts: [...this.spoofingAlerts],
      squeezeSignal: squeeze?.signal ?? null,
      squeezeProbability: squeeze?.probability ?? 0,
      liquidityMagnetZones: zones,
      updatedAt: now,
    };

    return { squeeze, zones, newSpoofs: book.newSpoofs, telemetry: this.latestTelemetry };
  }

  getTelemetry(): LiquidityHunterTelemetry {
    return this.latestTelemetry;
  }
}
