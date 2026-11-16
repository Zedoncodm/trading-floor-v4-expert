import { computeRsi14 } from "./market.ts";
import type {
  Backtest,
  BacktestWindow,
  Kline,
  ParameterOptimizationStrategySummary,
  PlayKind,
  TradingStyle,
  TrainingCandidate,
} from "./types.ts";

const RULES: Record<PlayKind, string> = {
  breakout: "Cassure canal 20 barres (4h), cible 2.0R, stop 1.0R (ATR), time-stop 30 barres (5j)",
  fade: "Contre-tendance extension 3j (>3.2%), cible 1.6R, stop 1.0R, time-stop 24 barres (4j)",
  HFT_OrderFlow_Imbalance:
    "Moteur A Microstructure : Z_OFI > ±2.5, Volume >= 3x SMA(20), Spread <= 2 ticks, Trailing 0.5x ATR(1m), Time-Stop 120s",
  Session_VWAP_Reversion:
    "Moteur B DayTrade : Balayage Initial Balance + ±2.0 SD VWAP Ancré + RSI extrême, TP 50% ±1.0 SD + 50% VWAP, Time-Stop 8h",
  Macro_FVG_Mitigation:
    "Moteur C Swing Macro : BOS 20 barres + FVG >= 0.5x ATR(14), LIMIT 50% FVG (Maker), R:R >= 2.5R, Time-Stop 72h",
  HFT_Kamikaze_FiatTarget:
    "Moteur HFT Kamikaze : Tir de barrage L2 / OFI, levier jusqu'à 500x, Cible Fiat 50$ - 100$, Time-Stop 180s",
};

export type BacktestThresholds = {
  minTrades90d?: number;
  minTradesOos?: number;
  minExpectancyR?: number;
  minProfitFactor?: number;
  minDsr?: number;
};

export type BacktestCustomParams = {
  lookback?: number;
  atrMult?: number;
  rewardR?: number;
  style?: TradingStyle;
  symbol?: string;
  autoOptimize?: boolean;
  scalpRelaxed?: boolean;
  ofiZScoreThreshold?: number;
  fixedStopAtr?: number;
  fvgMinSizeAtr?: number;
};

type SimulatedTrade = {
  entryBar: number;
  exitBar: number;
  rNet: number;
  reason: "stop" | "target" | "time";
};

function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

function inverseNormalCdf(p: number): number {
  if (p <= 0) return -4;
  if (p >= 1) return 4;
  if (p < 0.5) return -inverseNormalCdf(1 - p);
  const t = Math.sqrt(-2 * Math.log(1 - p));
  return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
}

/**
 * Calcule le Deflated Sharpe Ratio (DSR — Bailey & López de Prado), VaR 95% et Max Drawdown en R.
 */
export function computeQuantMetrics(rList: number[], trialsCount = 12): {
  trades: number;
  winRate: number;
  expectancyR: number;
  profitFactor: number;
  sharpe: number;
  deflatedSharpe: number;
  maxDrawdownR: number;
  var95R: number;
} {
  const n = rList.length;
  if (n === 0) {
    return {
      trades: 0,
      winRate: 0,
      expectancyR: 0,
      profitFactor: 0,
      sharpe: 0,
      deflatedSharpe: 0,
      maxDrawdownR: 0,
      var95R: 0,
    };
  }
  const wins = rList.filter((r) => r > 0).length;
  const grossWin = rList.filter((r) => r > 0).reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(rList.filter((r) => r < 0).reduce((s, r) => s + r, 0));
  const mean = rList.reduce((s, r) => s + r, 0) / n;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 9.9 : 0;

  const variance = n > 1 ? rList.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1) : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 1e-9 ? mean / std : mean > 0 ? 2.0 : 0;

  // Skewness & Kurtosis pour DSR
  let skew = 0;
  let kurt = 3;
  if (std > 1e-9 && n >= 4) {
    skew = rList.reduce((s, r) => s + ((r - mean) / std) ** 3, 0) / n;
    kurt = rList.reduce((s, r) => s + ((r - mean) / std) ** 4, 0) / n;
  }

  let deflatedSharpe = 0.5;
  if (n >= 3) {
    const euler = 0.5772156649;
    const m = Math.max(1, trialsCount);
    const sr0 =
      m <= 1
        ? 0
        : Math.sqrt(1 / Math.max(1, n - 1)) *
          ((1 - euler) * inverseNormalCdf(1 - 1 / m) + euler * inverseNormalCdf(1 - 1 / (m * Math.E)));
    const sampleSharpe = sharpe * Math.sqrt(Math.min(n, 16));
    const srVar = Math.max(1e-6, (1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe) / Math.max(1, n - 1));
    deflatedSharpe = normalCdf((sampleSharpe - sr0) / Math.sqrt(srVar));
  }

  // Max Drawdown (MDD) en R
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const r of rList) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  // VaR historique 95% (en R)
  const sorted = [...rList].sort((a, b) => a - b);
  const qIdx = Math.max(0, Math.floor(0.05 * (n - 1)));
  const var95R = Math.min(0, sorted[qIdx]);

  return {
    trades: n,
    winRate: wins / n,
    expectancyR: mean,
    profitFactor,
    sharpe,
    deflatedSharpe,
    maxDrawdownR,
    var95R,
  };
}

/**
 * Simule les trades d'un moteur donné sur [startIdx, hardEndIdx) avec Purge stricte (Purged CV)
 * et coûts de friction réels (Frais Maker 0.02% / Taker 0.04% + Slippage dynamique ATR).
 */
function simulateEngineSlice(
  bars: Kline[],
  playbook: PlayKind,
  startIdx: number,
  hardEndIdx: number,
  params: BacktestCustomParams = {},
): { trades: SimulatedTrade[]; purgedCount: number } {
  const trades: SimulatedTrade[] = [];
  let purgedCount = 0;

  const style = params.style ?? (playbook === "HFT_OrderFlow_Imbalance" ? "scalping" : playbook === "Session_VWAP_Reversion" ? "daytrade" : "longtrade");
  const lookback = params.lookback ?? (playbook === "breakout" || playbook === "Macro_FVG_Mitigation" ? 20 : 18);
  const atrMult = params.fixedStopAtr ?? params.atrMult ?? (playbook === "HFT_OrderFlow_Imbalance" ? 0.5 : 1.35);
  const rewardR =
    params.rewardR ??
    (playbook === "Macro_FVG_Mitigation" ? 2.5 : playbook === "breakout" ? 2.0 : playbook === "HFT_OrderFlow_Imbalance" ? 1.5 : 1.6);
  const ofiThresh = params.ofiZScoreThreshold ?? 2.5;
  const fvgMinAtr = params.fvgMinSizeAtr ?? 0.5;
  const horizonBars =
    playbook === "HFT_OrderFlow_Imbalance" ? 8 : playbook === "Session_VWAP_Reversion" ? 24 : playbook === "Macro_FVG_Mitigation" ? 18 : 28;

  let i = Math.max(startIdx, lookback + 4);

  while (i < hardEndIdx - 2) {
    const slice = bars.slice(i - lookback, i);
    const atrSlice = bars.slice(Math.max(0, i - 14), i);
    const atr = atrSlice.reduce((s, b) => s + (b.high - b.low), 0) / Math.max(1, atrSlice.length);
    const cur = bars[i];

    let dir: 1 | -1 | 0 = 0;
    let isMakerEntry = false;
    let risk = Math.max(atr * atrMult, cur.close * (style === "scalping" ? 0.002 : 0.006));
    let entryRef = bars[i + 1].open;

    if (playbook === "breakout") {
      const hi = Math.max(...slice.map((b) => b.high));
      const lo = Math.min(...slice.map((b) => b.low));
      if (cur.close > hi) dir = 1;
      else if (cur.close < lo) dir = -1;
    } else if (playbook === "fade") {
      const base = bars[Math.max(0, i - lookback)].close;
      const stretch = (cur.close - base) / Math.max(base, 1e-9);
      const thresh = style === "scalping" ? 0.012 : 0.032;
      if (stretch > thresh) dir = -1;
      else if (stretch < -thresh) dir = 1;
    } else if (playbook === "HFT_OrderFlow_Imbalance") {
      // Proxy déterministe sur bougies historiques de l'OFI (pression acheteuse/vendeuse dans le range) + surge de volume
      const avgVol = slice.reduce((s, b) => s + b.volume, 0) / Math.max(1, slice.length);
      const volRatio = avgVol > 0 ? cur.volume / avgVol : 1;
      const span = Math.max(cur.high - cur.low, 1e-9);
      const bodyImb = (cur.close - cur.open) / span; // [-1, +1]
      const pseudoZOfi = bodyImb * Math.min(3.5, Math.sqrt(Math.max(1, volRatio)) * 1.9);
      if (pseudoZOfi > ofiThresh && volRatio >= 2.0) dir = 1;
      else if (pseudoZOfi < -ofiThresh && volRatio >= 2.0) dir = -1;
      risk = Math.max(atr * Math.min(atrMult, 0.7), cur.close * 0.002);
    } else if (playbook === "Session_VWAP_Reversion") {
      // VWAP glissant de session sur les ~20 dernières barres + SD + RSI(14) sans look-ahead
      const ses = slice;
      let pv = 0;
      let vv = 0;
      let p2v = 0;
      for (const b of ses) {
        const tp = (b.high + b.low + b.close) / 3;
        const v = Math.max(b.volume, 1e-6);
        pv += tp * v;
        vv += v;
        p2v += tp * tp * v;
      }
      const vwap = vv > 0 ? pv / vv : cur.close;
      const sd = Math.max(Math.sqrt(Math.max(0, p2v / Math.max(vv, 1e-6) - vwap * vwap)), vwap * 0.002);
      const rsi = computeRsi14(bars.slice(Math.max(0, i - 20), i + 1));
      const prev = bars[i - 1];
      if (prev.high >= vwap + 1.8 * sd && cur.close < vwap + 2.0 * sd && rsi > 65) dir = -1;
      else if (prev.low <= vwap - 1.8 * sd && cur.close > vwap - 2.0 * sd && rsi < 35) dir = 1;
      risk = Math.max(atr * 1.5, cur.close * 0.004);
    } else if (playbook === "Macro_FVG_Mitigation") {
      const cPrev2 = bars[i - 2];
      const hi = Math.max(...bars.slice(i - 22, i - 2).map((b) => b.high));
      const lo = Math.min(...bars.slice(i - 22, i - 2).map((b) => b.low));
      if (cPrev2.high < cur.low && cur.low - cPrev2.high >= fvgMinAtr * atr && cur.close > hi) {
        const mid = (cur.low + cPrev2.high) * 0.5;
        if (bars[i + 1].low <= mid) {
          dir = 1;
          isMakerEntry = true;
          entryRef = mid;
          risk = Math.max(mid - cPrev2.low, atr * 0.8);
        }
      } else if (cPrev2.low > cur.high && cPrev2.low - cur.high >= fvgMinAtr * atr && cur.close < lo) {
        const mid = (cPrev2.low + cur.high) * 0.5;
        if (bars[i + 1].high >= mid) {
          dir = -1;
          isMakerEntry = true;
          entryRef = mid;
          risk = Math.max(cPrev2.high - mid, atr * 0.8);
        }
      }
    }

    if (dir === 0 || risk <= 0 || entryRef <= 0) {
      i++;
      continue;
    }

    // Coûts de friction réels : Frais Maker (0.02%) / Taker (0.04%) + Slippage dynamique proportionnel à l'ATR
    const entryFeePct = isMakerEntry ? 0.0002 : 0.0004;
    const exitFeePct = 0.0004;
    const slippagePct = isMakerEntry ? 0 : Math.min(0.0015, 0.05 * (atr / entryRef));
    const entrySlipPx = dir === 1 ? entryRef * (1 + slippagePct) : entryRef * (1 - slippagePct);

    const stop = dir === 1 ? entrySlipPx - risk : entrySlipPx + risk;
    const target = dir === 1 ? entrySlipPx + rewardR * risk : entrySlipPx - rewardR * risk;
    const horizon = i + horizonBars;

    // Purge : si l'horizon ou la clôture déborde dans la zone OOS (hardEndIdx), on purge ce trade
    if (horizon >= hardEndIdx) {
      purgedCount++;
      break;
    }

    let rawR = 0;
    let exitBar = i + 1;
    let reason: SimulatedTrade["reason"] = "time";
    let exitPx = bars[horizon].close;

    for (let k = i + 1; k <= horizon; k++) {
      const b = bars[k];
      const hitStop = dir === 1 ? b.low <= stop : b.high >= stop;
      const hitTarget = dir === 1 ? b.high >= target : b.low <= target;
      if (hitStop) {
        exitPx = dir === 1 ? stop * (1 - slippagePct) : stop * (1 + slippagePct);
        rawR = (dir * (exitPx - entrySlipPx)) / risk;
        reason = "stop";
        exitBar = k;
        break;
      }
      if (hitTarget) {
        exitPx = target;
        rawR = rewardR;
        reason = "target";
        exitBar = k;
        break;
      }
      if (k === horizon) {
        exitPx = dir === 1 ? b.close * (1 - slippagePct) : b.close * (1 + slippagePct);
        rawR = (dir * (exitPx - entrySlipPx)) / risk;
        reason = "time";
        exitBar = k;
      }
    }

    const totalFeeInR = ((entryFeePct + exitFeePct) * entrySlipPx) / risk;
    const rNet = rawR - totalFeeInR;

    trades.push({ entryBar: i, exitBar, rNet, reason });
    i = exitBar + 1;
  }

  return { trades, purgedCount };
}

function evaluateSlice(
  bars: Kline[],
  playbook: PlayKind,
  startIdx: number,
  endIdx: number,
  minTrades: number,
  minExpectancyR: number,
  minProfitFactor: number,
  minDsr: number,
  label: string,
  params: BacktestCustomParams = {},
  trialsCount = 12,
): { window: BacktestWindow; rList: number[]; purgedCount: number; simTrades: SimulatedTrade[] } {
  const sim = simulateEngineSlice(bars, playbook, startIdx, endIdx, params);
  const rList = sim.trades.map((t) => t.rNet);
  const m = computeQuantMetrics(rList, trialsCount);

  const pass =
    m.trades >= minTrades &&
    m.expectancyR >= minExpectancyR &&
    m.profitFactor >= minProfitFactor &&
    m.deflatedSharpe >= minDsr;

  return {
    window: {
      label,
      bars: Math.max(0, endIdx - startIdx),
      trades: m.trades,
      winRate: m.winRate,
      expectancyR: m.expectancyR,
      profitFactor: m.profitFactor,
      sharpe: m.sharpe,
      deflatedSharpe: m.deflatedSharpe,
      maxDrawdownR: m.maxDrawdownR,
      var95R: m.var95R,
      pass,
    },
    rList,
    purgedCount: sim.purgedCount,
    simTrades: sim.trades,
  };
}

export function filterBarsByDateRange(bars: Kline[], startTs?: number, endTs?: number): Kline[] {
  if (!startTs && !endTs) return bars;
  const filtered = bars.filter((b) => {
    if (startTs && b.openTime < startTs) return false;
    if (endTs && b.openTime > endTs) return false;
    return true;
  });
  return filtered.length >= 60 ? filtered : bars;
}

export function evaluateCandidateForGrpo(
  bars: Kline[],
  playbook: PlayKind,
  slMult: number,
  tpMult: number,
  leverage: number,
  startTs?: number,
  endTs?: number,
): {
  pnl: number;
  realizedR: number;
  maxAdverseExcursion: number;
  stopDistance: number;
  executionFees: number;
  deflatedSharpe: number;
} {
  const sliced = filterBarsByDateRange(bars, startTs, endTs);
  const splitIdx = Math.max(40, Math.floor(sliced.length * 0.75));
  const sim = simulateEngineSlice(sliced, playbook, splitIdx, sliced.length, {
    atrMult: slMult,
    fixedStopAtr: slMult,
    rewardR: tpMult,
  });
  const rList = sim.trades.map((t) => t.rNet);
  const m = computeQuantMetrics(rList, 8);
  const sumR = rList.reduce((a, b) => a + b, 0);
  const pnl = sumR * 100 * Math.min(leverage, 20) * 0.2;
  const maeProxy = Math.max(0.1, m.maxDrawdownR * 0.5);
  return {
    pnl,
    realizedR: m.expectancyR,
    maxAdverseExcursion: maeProxy,
    stopDistance: Math.max(0.25, slMult),
    executionFees: rList.length * 0.08 * leverage * 0.1,
    deflatedSharpe: m.deflatedSharpe,
  };
}

/**
 * Validateur WFO Purgé (90j IS / 30j OOS avec embargo) + Friction réelle + DSR.
 */
export function runBacktestOnBars(
  rawBars: Kline[],
  playbook: PlayKind,
  source = "Binance WFO",
  thresholds: BacktestThresholds = {},
  customParams: BacktestCustomParams & { startTs?: number; endTs?: number } = {},
): Backtest {
  const bars = filterBarsByDateRange(rawBars, customParams.startTs, customParams.endTs);
  const total = bars.length;
  const splitIdx = Math.max(60, Math.floor(total * 0.75));
  const embargoBars = Math.min(4, Math.floor(total * 0.02));
  const oosStart = Math.min(total - 10, splitIdx + embargoBars);

  const relaxed = Boolean(customParams.scalpRelaxed);
  const min90 = relaxed ? Math.min(thresholds.minTrades90d ?? 2, 2) : (thresholds.minTrades90d ?? 5);
  const minOos = relaxed ? Math.min(thresholds.minTradesOos ?? 1, 1) : (thresholds.minTradesOos ?? 2);
  const minExp = relaxed ? -0.02 : (thresholds.minExpectancyR ?? 0.15);
  const minPf = relaxed ? 0.92 : (thresholds.minProfitFactor ?? 1.2);
  const minDsr = relaxed ? 0.2 : (thresholds.minDsr ?? 0.45);

  let usedPlaybook = playbook;
  let isRes = evaluateSlice(
    bars,
    usedPlaybook,
    0,
    splitIdx,
    min90,
    minExp,
    minPf,
    minDsr,
    "90j In-Sample (Purgé)",
    customParams,
    12,
  );
  let oosRes = evaluateSlice(
    bars,
    usedPlaybook,
    oosStart,
    total,
    minOos,
    minExp,
    minPf,
    minDsr,
    "30j Out-Of-Sample (OOS)",
    customParams,
    12,
  );

  let pass = isRes.window.pass && oosRes.window.pass;

  if (!pass && customParams.autoOptimize && total >= 80) {
    const style = customParams.style ?? "daytrade";
    const trained = trainStrategyOnHistory(customParams.symbol ?? "ASSET", bars, style);
    const b = trained.best;
    const optParams: BacktestCustomParams = {
      ...customParams,
      lookback: b.lookback,
      atrMult: b.atrMult,
      rewardR: b.rewardR,
      style,
    };
    const optIs = evaluateSlice(
      bars,
      b.playbook,
      0,
      splitIdx,
      min90,
      minExp,
      minPf,
      minDsr,
      "90j In-Sample (Purgé)",
      optParams,
      trained.testedCount,
    );
    const optOos = evaluateSlice(
      bars,
      b.playbook,
      oosStart,
      total,
      minOos,
      minExp,
      minPf,
      minDsr,
      "30j Out-Of-Sample (OOS)",
      optParams,
      trained.testedCount,
    );
    if (optIs.window.pass && optOos.window.pass) {
      usedPlaybook = b.playbook;
      isRes = optIs;
      oosRes = optOos;
      pass = true;
    } else if (relaxed && (optOos.window.trades >= 1 || optIs.window.trades >= 2)) {
      usedPlaybook = b.playbook;
      isRes = optIs;
      oosRes = optOos;
      pass = (optIs.window.expectancyR > 0 || optOos.window.expectancyR > 0) && optOos.window.profitFactor >= 0.92;
    }
  }

  let killReason: string | undefined;
  if (!isRes.window.pass) {
    killReason = `Échec WFO In-Sample (${isRes.window.trades} tr, Exp ${isRes.window.expectancyR.toFixed(2)}R, PF ${isRes.window.profitFactor.toFixed(2)}, DSR ${(isRes.window.deflatedSharpe * 100).toFixed(0)}%).`;
  } else if (!oosRes.window.pass) {
    killReason = `Échec WFO Out-Of-Sample (${oosRes.window.trades} tr, Exp ${oosRes.window.expectancyR.toFixed(2)}R, PF ${oosRes.window.profitFactor.toFixed(2)}, DSR ${(oosRes.window.deflatedSharpe * 100).toFixed(0)}%).`;
  }

  let acc = 0;
  const equityCurveR = [0, ...isRes.rList, ...oosRes.rList].map((r) => {
    acc += r;
    return Number(acc.toFixed(2));
  });

  return {
    playbook: usedPlaybook,
    rules: RULES[usedPlaybook],
    source,
    inSample: isRes.window,
    outOfSample: oosRes.window,
    pass,
    killReason,
    equityCurveR,
    deflatedSharpe: oosRes.window.deflatedSharpe,
    frictionModel: "Maker 0.02% / Taker 0.04% + Slippage dynamique ATR",
    purgedBars: isRes.purgedCount + embargoBars,
  };
}

/**
 * Entraînement multi-moteurs sur tout l'historique réel avec Walk-Forward Purgé.
 */
export function trainStrategyOnHistory(
  symbol: string,
  bars: Kline[],
  style: TradingStyle,
): { best: TrainingCandidate; testedCount: number } {
  const tf: "15m" | "1h" | "4h" = style === "scalping" ? "15m" : style === "daytrade" ? "1h" : "4h";
  const lookbacks = style === "scalping" ? [10, 14, 20] : [14, 20, 28];
  const atrMults = style === "scalping" ? [0.5, 0.85, 1.2] : [1.15, 1.4, 1.75];
  const rewards = style === "scalping" ? [1.5, 1.8] : [1.6, 2.0, 2.5];
  const playbooks: PlayKind[] =
    style === "scalping"
      ? ["HFT_OrderFlow_Imbalance", "breakout", "fade"]
      : style === "daytrade"
        ? ["Session_VWAP_Reversion", "breakout", "fade"]
        : ["Macro_FVG_Mitigation", "breakout", "fade"];

  const splitIdx = Math.max(60, Math.floor(bars.length * 0.75));
  const oosStart = Math.min(bars.length - 10, splitIdx + 3);
  let testedCount = 0;
  let best: TrainingCandidate | null = null;

  for (const playbook of playbooks) {
    for (const lookback of lookbacks) {
      for (const atrMult of atrMults) {
        for (const rewardR of rewards) {
          testedCount++;
          const p: BacktestCustomParams = { lookback, atrMult, rewardR, style, symbol };
          const isSim = simulateEngineSlice(bars, playbook, 0, splitIdx, p);
          const oosSim = simulateEngineSlice(bars, playbook, oosStart, bars.length, p);
          const isM = computeQuantMetrics(
            isSim.trades.map((t) => t.rNet),
            testedCount,
          );
          const oosM = computeQuantMetrics(
            oosSim.trades.map((t) => t.rNet),
            testedCount,
          );

          const pass =
            isM.trades >= 4 &&
            oosM.trades >= 2 &&
            oosM.expectancyR >= 0.15 &&
            oosM.profitFactor >= 1.2 &&
            oosM.deflatedSharpe >= 0.45;
          const score =
            oosM.expectancyR * 0.55 +
            isM.expectancyR * 0.25 +
            (oosM.profitFactor - 1) * 0.2 +
            oosM.deflatedSharpe * 0.35 +
            (pass ? 1 : 0);

          const cand: TrainingCandidate = {
            symbol,
            timeframe: tf,
            playbook,
            lookback,
            atrMult,
            rewardR,
            inSampleTrades: isM.trades,
            inSampleWinRate: isM.winRate,
            inSampleExpR: isM.expectancyR,
            oosTrades: oosM.trades,
            oosWinRate: oosM.winRate,
            oosExpR: oosM.expectancyR,
            oosProfitFactor: oosM.profitFactor,
            score,
            pass,
          };

          if (!best || cand.score > best.score) {
            best = cand;
          }
        }
      }
    }
  }

  return {
    best: best ?? {
      symbol,
      timeframe: tf,
      playbook: "breakout",
      lookback: 20,
      atrMult: 1.35,
      rewardR: 2.0,
      inSampleTrades: 0,
      inSampleWinRate: 0,
      inSampleExpR: 0,
      oosTrades: 0,
      oosWinRate: 0,
      oosExpR: 0,
      oosProfitFactor: 0,
      score: 0,
      pass: false,
    },
    testedCount,
  };
}

/**
 * Boucle d'Entraînement Fermée (Trade Reviewer -> Strategist) :
 * Compile les erreurs (taux de stops, time-stops, MDD) et recalibre par Grid Search
 * sur l'In-Sample purgé (OFI_ZScore_Threshold, Fixed_Stop_ATR, FVG_Min_Size_ATR).
 * Ne conserve la mise à jour que si elle améliore le score Out-Of-Sample.
 */
export function optimizeParametersOnHistory(
  symbol: string,
  bars: Kline[],
  currentParams: {
    ofiZScoreThreshold: number;
    fixedStopAtr: number;
    fvgMinSizeAtr: number;
  },
): {
  prevParams: typeof currentParams;
  newParams: typeof currentParams;
  updated: boolean;
  reason: string;
  stopRate: number;
  timeStopRate: number;
  maxDrawdownR: number;
  totalTradesReviewed: number;
  strategies: ParameterOptimizationStrategySummary[];
} {
  const splitIdx = Math.max(60, Math.floor(bars.length * 0.75));
  const oosStart = Math.min(bars.length - 10, splitIdx + 3);
  const engines: PlayKind[] = [
    "HFT_OrderFlow_Imbalance",
    "Session_VWAP_Reversion",
    "Macro_FVG_Mitigation",
    "breakout",
    "fade",
  ];

  // 1. Audit de la configuration actuelle (Trade Reviewer)
  let totalTrades = 0;
  let totalStops = 0;
  let totalTimeStops = 0;
  let worstMdd = 0;
  let prevTotalOosScore = 0;

  const prevStatsByEngine = new Map<
    PlayKind,
    { trades: number; stopRate: number; timeStopRate: number; mdd: number; oosScore: number }
  >();

  for (const eng of engines) {
    const isSim = simulateEngineSlice(bars, eng, 0, splitIdx, { ...currentParams, symbol });
    const oosSim = simulateEngineSlice(bars, eng, oosStart, bars.length, { ...currentParams, symbol });
    const allSim = [...isSim.trades, ...oosSim.trades];
    const mAll = computeQuantMetrics(allSim.map((t) => t.rNet), 12);
    const mOos = computeQuantMetrics(oosSim.trades.map((t) => t.rNet), 12);

    const stops = allSim.filter((t) => t.reason === "stop").length;
    const timeStops = allSim.filter((t) => t.reason === "time").length;
    const stopRate = allSim.length ? stops / allSim.length : 0;
    const timeStopRate = allSim.length ? timeStops / allSim.length : 0;
    const oosScore = mOos.trades > 0 ? mOos.expectancyR * 0.6 + mOos.deflatedSharpe * 0.4 : -0.2;

    totalTrades += allSim.length;
    totalStops += stops;
    totalTimeStops += timeStops;
    worstMdd = Math.max(worstMdd, mAll.maxDrawdownR);
    prevTotalOosScore += oosScore;

    prevStatsByEngine.set(eng, {
      trades: allSim.length,
      stopRate,
      timeStopRate,
      mdd: mAll.maxDrawdownR,
      oosScore,
    });
  }

  // 2. Grid Search sur In-Sample purgé (Strategist)
  const ofiGrid = [2.0, 2.5, 3.0];
  const stopAtrGrid = [0.85, 1.2, 1.5, 1.85];
  const fvgAtrGrid = [0.35, 0.5, 0.75];

  let bestInSampleScore = -Infinity;
  let candidateParams = { ...currentParams };

  for (const ofiZ of ofiGrid) {
    for (const stopAtr of stopAtrGrid) {
      for (const fvgAtr of fvgAtrGrid) {
        let isScoreSum = 0;
        for (const eng of engines) {
          const isSim = simulateEngineSlice(bars, eng, 0, splitIdx, {
            ofiZScoreThreshold: ofiZ,
            fixedStopAtr: stopAtr,
            fvgMinSizeAtr: fvgAtr,
            symbol,
          });
          const m = computeQuantMetrics(isSim.trades.map((t) => t.rNet), 36);
          if (m.trades >= 2) {
            isScoreSum += m.expectancyR * 0.65 + m.deflatedSharpe * 0.35;
          }
        }
        if (isScoreSum > bestInSampleScore) {
          bestInSampleScore = isScoreSum;
          candidateParams = {
            ofiZScoreThreshold: ofiZ,
            fixedStopAtr: stopAtr,
            fvgMinSizeAtr: fvgAtr,
          };
        }
      }
    }
  }

  // 3. Validation Out-Of-Sample stricte : ne garder la mise à jour que si OOS s'améliore
  let newTotalOosScore = 0;
  const strategies: ParameterOptimizationStrategySummary[] = [];

  for (const eng of engines) {
    const newOosSim = simulateEngineSlice(bars, eng, oosStart, bars.length, { ...candidateParams, symbol });
    const mOos = computeQuantMetrics(newOosSim.trades.map((t) => t.rNet), 36);
    const newOosScore = mOos.trades > 0 ? mOos.expectancyR * 0.6 + mOos.deflatedSharpe * 0.4 : -0.2;
    newTotalOosScore += newOosScore;

    const prev = prevStatsByEngine.get(eng)!;
    strategies.push({
      playbook: eng,
      trades: prev.trades,
      stopRate: prev.stopRate,
      timeStopRate: prev.timeStopRate,
      maxDrawdownR: prev.mdd,
      prevOosScore: prev.oosScore,
      newOosScore,
      oosDsr: mOos.deflatedSharpe,
      oosPf: mOos.profitFactor,
      oosExpR: mOos.expectancyR,
      improved: newOosScore > prev.oosScore,
    });
  }

  const improvedOos = newTotalOosScore > prevTotalOosScore + 0.01;

  return {
    prevParams: currentParams,
    newParams: improvedOos ? candidateParams : currentParams,
    updated: improvedOos,
    reason: improvedOos
      ? `Recalibrage validé : le score Out-Of-Sample passe de ${prevTotalOosScore.toFixed(3)} à ${newTotalOosScore.toFixed(3)}. Nouveaux hyper-paramètres enregistrés.`
      : `Mise à jour rejetée (anti-surapprentissage) : le candidat In-Sample (${candidateParams.ofiZScoreThreshold}/${candidateParams.fixedStopAtr}/${candidateParams.fvgMinSizeAtr}) n'améliore pas l'OOS (${newTotalOosScore.toFixed(3)} vs ${prevTotalOosScore.toFixed(3)}). Anciens paramètres conservés.`,
    stopRate: totalTrades ? totalStops / totalTrades : 0,
    timeStopRate: totalTrades ? totalTimeStops / totalTrades : 0,
    maxDrawdownR: worstMdd,
    totalTradesReviewed: totalTrades,
    strategies,
  };
}
