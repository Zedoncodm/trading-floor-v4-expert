import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Config } from "../src/config.ts";
import { computeLeveragedSizing, SocialSentimentEngine, TradingFloorDesk } from "../src/desk.ts";
import { GrpoEngine } from "../src/rl/grpo.ts";
import { DeskStore } from "../src/store.ts";
import { TelegramFloorRoom } from "../src/telegram.ts";
import { LiquidityHunterAgent } from "../src/agents/liquidityHunter.ts";
import { SentinelAgent, TokenBucketRateLimiter } from "../src/agents/sentinel.ts";
import { Mt5CloudBridge } from "../src/mt5.ts";
import { DASHBOARD_HTML } from "../src/ui.ts";

function makeTestCfg(dataDir: string): Config {
  return {
    mode: "console",
    tradingMode: "paper",
    tokens: {
      lead: "",
      analyst: "",
      strategist: "",
      risk: "",
      execution: "",
      reviewer: "",
      sentinel: "",
      hunter: "",
    },
    chatId: "",
    humanUserId: 0,
    humanUsername: "tester",
    timeZone: "Europe/Paris",
    paperEquity: 10_000,
    symbols: ["BTCUSDT", "ETHUSDT"],
    scanIntervalMin: 15,
    monitorIntervalSec: 5,
    ticketTtlMin: 15,
    overnightStart: 23,
    overnightEnd: 7,
    reportHour: 9,
    dataDir,
    binanceKey: "",
    binanceSecret: "",
  };
}

test("computeLeveragedSizing enforces exact formula, Liquidation Guard Hard Veto, and auto-reduction", () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-v3-lev-"));
  try {
    const store = new DeskStore(dir);
    const state = store.loadOrCreate(10_000, "Europe/Paris", ["BTCUSDT"], 15);
    state.settings.maxRiskPct = 0.01;
    state.settings.stopMaxPct = 0.25;

    // Case 1: Safe LONG with 5x leverage
    // entry=100, stop=95 (5% distance), lev=5x, mmr=0.005 -> liqPrice = 100 * (1 - 0.2 + 0.005) = 80.5
    const safeRes = computeLeveragedSizing(state, 100, 95, undefined, {
      side: "long",
      leverageFactor: 5,
      maintenanceMarginRate: 0.005,
      takerFee: 0.0004,
      expectedSlippage: 0.0002,
      autoReduceLeverage: false,
    });
    assert.equal(safeRes.ok, true);
    assert.equal(safeRes.leverage, 5);
    assert.ok(Math.abs((safeRes.liqPrice ?? 0) - 80.5) < 1e-6);
    const expectedRaw = (10_000 * 0.01) / (0.05 + 0.0004 * 2 + 0.0002);
    assert.ok(Math.abs((safeRes.notional ?? 0) - expectedRaw) < 1e-4);

    // Case 2: HARD VETO when stop is within 15% buffer of liqPrice (autoReduceLeverage: false)
    // entry=100, stop=91 (9% stop), lev=10x, mmr=0.005 -> liqPrice=90.5 -> (91 - 90.5) / 9.5 = 5.26% < 15%
    const vetoRes = computeLeveragedSizing(state, 100, 91, undefined, {
      side: "long",
      leverageFactor: 10,
      maintenanceMarginRate: 0.005,
      autoReduceLeverage: false,
    });
    assert.equal(vetoRes.ok, false);
    assert.match(vetoRes.reason ?? "", /HARD VETO|liquidation/i);

    // Case 3: Auto-reduction reduces leverage until stop is outside 15% buffer (SHORT test too)
    // entry=100, stop=109 (9% stop), requested lev=10x -> liqShort at 10x is 109.5 (unsafe) -> reduces down
    const reducedShort = computeLeveragedSizing(state, 100, 109, undefined, {
      side: "short",
      leverageFactor: 10,
      maintenanceMarginRate: 0.005,
      autoReduceLeverage: true,
    });
    assert.equal(reducedShort.ok, true);
    assert.ok((reducedShort.leverage ?? 10) < 10);
    assert.ok((reducedShort.liqPrice ?? 0) > 109);

    // Case 4: Extreme leverage up to 500x with safe tight stop (0.10% stop vs ~0.13% liq distance)
    const extremeLev = computeLeveragedSizing(state, 100, 99.9, undefined, {
      side: "long",
      leverageFactor: 500,
      maintenanceMarginRate: 0.005,
      autoReduceLeverage: false,
    });
    assert.equal(extremeLev.ok, true);
    assert.equal(extremeLev.leverage, 500);
    assert.ok((extremeLev.liqPrice ?? 0) > 99.8 && (extremeLev.liqPrice ?? 0) < 99.9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SocialSentimentEngine extracts cashtags and normalizes score within [-1, +1]", () => {
  const engine = new SocialSentimentEngine();
  const now = Date.now();
  engine.ingestPosts(
    [
      { author: "whale1", authority: 3.0, text: "$BTC breakout surge bullish inflow", likes: 500, retweets: 100, timestamp: now },
      { author: "whale2", authority: 2.0, text: "$SOL crash liquidation dump bear", likes: 200, retweets: 50, timestamp: now },
    ],
    now,
  );
  const btcScore = engine.getScore("BTCUSDT");
  const solScore = engine.getScore("SOLUSDT");
  assert.ok(btcScore > 0.5 && btcScore <= 1.0);
  assert.ok(solScore < -0.5 && solScore >= -1.0);
  const snap = engine.getSamplesSnapshot();
  assert.ok(snap.BTCUSDT.cashtags.includes("$BTC"));
  assert.equal(snap.BTCUSDT.mentions, 1);
});

test("TradingFloorDesk webhooks handle Macro VOLATILITY_SHIELD and FOMO validation gates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-v3-hooks-"));
  try {
    const cfg = makeTestCfg(dir);
    const store = new DeskStore(dir);
    const tg = new TelegramFloorRoom(cfg);
    const grpo = new GrpoEngine(join(dir, "rl_policy_memory.json"), join(dir, "reviewer_reports.json"));
    const desk = new TradingFloorDesk(cfg, store, tg, grpo);

    const macroRes = await desk.ingestMacroWebhook({
      event: "US CPI YoY",
      actual: 3.4,
      forecast: 3.1,
      previous: 3.0,
      timestamp: Date.now(),
      impact: "HIGH",
    });
    assert.equal(macroRes.ok, true);
    assert.ok(Math.abs(macroRes.macroSurpriseIndex - (3.4 - 3.1) / 3.1) < 1e-6);
    assert.equal(macroRes.volatilityShieldActive, true);
    assert.equal(desk.isVolatilityShieldActive(), true);

    const lowWr = await desk.ingestFomoWebhook({
      traderId: "degen_low",
      winRate: 0.45,
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 90000,
      leverage: 5,
      timestamp: Date.now(),
    });
    assert.equal(lowWr.accepted, false);

    const stale = await desk.ingestFomoWebhook({
      traderId: "slow_whale",
      winRate: 0.78,
      symbol: "BTCUSDT",
      side: "LONG",
      entryPrice: 90000,
      leverage: 5,
      timestamp: Date.now() - 8000,
    });
    assert.equal(stale.accepted, false);

    const valid = await desk.ingestFomoWebhook({
      traderId: "top_quant",
      winRate: 0.74,
      symbol: "ETHUSDT",
      side: "LONG",
      entryPrice: 3200,
      leverage: 5,
      timestamp: Date.now(),
    });
    assert.equal(valid.accepted, true);
    assert.equal(valid.fomoConfluenceBoost, 0.15);
    assert.equal(desk.getActiveFomoBoost("ETHUSDT", "long"), 0.15);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GrpoEngine computes normalized advantages, atomic persistence with .bak, and reviewer diagnostics", () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-v3-grpo-"));
  const memPath = join(dir, "rl_policy_memory.json");
  const revPath = join(dir, "reviewer_reports.json");
  try {
    const grpo = new GrpoEngine(memPath, revPath);
    const cands = grpo.sampleCandidateGroup(
      {
        regime: "TRENDING_UP",
        volatility: 0.015,
        ofiZScore: 1.8,
        vwapZScore: 1.2,
        fvgProximity: 0.4,
        macroSurprise: 0,
        socialScore: 0.4,
      },
      4,
      42,
    );
    assert.equal(cands.length, 4);

    const outcomes = cands.map((c, idx) => ({
      config: c,
      pnl: idx === 0 ? 450 : -80 * idx,
      realizedR: idx === 0 ? 2.4 : -0.6 * idx,
      maxAdverseExcursion: idx === 0 ? 0.1 : 0.7,
      stopDistance: 0.01,
      executionFees: 2.5,
    }));

    const upd = grpo.updatePolicyFromGroup("TRENDING_UP", outcomes);
    const advSum = upd.advantages.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(advSum) < 1e-6);
    assert.ok(upd.klDivergence >= 0);

    // Trigger second update so atomic save rotates backup .bak
    grpo.updatePolicyFromGroup("TRENDING_UP", outcomes);
    assert.equal(existsSync(memPath), true);
    assert.equal(existsSync(memPath + ".bak"), true);

    const entry = grpo.appendReviewerDiagnostic({
      at: Date.now(),
      ticketId: "TF-TEST-01",
      symbol: "BTCUSDT",
      regime: "TRENDING_UP",
      strategy: cands[0].strategy,
      realizedPnl: 450,
      realizedR: 2.4,
      advantageShift: upd.advantages[0],
      klDivergence: upd.klDivergence,
      winningFeatures: ["OFI", "FOMO"],
      losingFeatures: [],
      parameterAdjustments: "SL=1.20",
    });
    assert.match(entry.markdown, /TF-TEST-01/);
    const rawLog = JSON.parse(readFileSync(revPath, "utf8")) as unknown[];
    assert.equal(rawLog.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TradingFloorDesk emergency kill switches liquidate all positions and toggle manual halt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-v3-panic-"));
  try {
    const cfg = makeTestCfg(dir);
    const store = new DeskStore(dir);
    const tg = new TelegramFloorRoom(cfg);
    const grpo = new GrpoEngine(join(dir, "rl_policy_memory.json"), join(dir, "reviewer_reports.json"));
    const desk = new TradingFloorDesk(cfg, store, tg, grpo);

    desk.state.tickets.push({
      id: "TF-PANIC-01",
      asset: "BTCUSDT",
      direction: "long",
      playbook: "breakout",
      thesis: "Test emergency close",
      entry: 90_000,
      invalidation: 89_000,
      target: 92_000,
      timeStopHours: 24,
      notional: 2_000,
      qty: 2_000 / 90_000,
      riskUsd: 22.22,
      riskPct: 0.0022,
      exposurePct: 0.2,
      binding: "risk",
      producedBy: ["lead"],
      status: "open",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      fillPrice: 90_000,
      fees: 0.8,
      funding: 0,
      backtest: {
        playbook: "breakout",
        rules: "test",
        source: "test",
        inSample: { label: "IS", bars: 100, trades: 10, winRate: 0.6, expectancyR: 0.3, profitFactor: 1.5, sharpe: 1.2, deflatedSharpe: 0.5, maxDrawdownR: 2, var95R: 1, pass: true },
        outOfSample: { label: "OOS", bars: 50, trades: 5, winRate: 0.6, expectancyR: 0.3, profitFactor: 1.5, sharpe: 1.2, deflatedSharpe: 0.5, maxDrawdownR: 2, var95R: 1, pass: true },
        pass: true,
      },
    });

    const liqOut = await desk.emergencyLiquidateAll();
    assert.equal(liqOut.ok, true);
    assert.equal(liqOut.closedCount, 1);
    assert.equal(desk.state.tickets.find((t) => t.id === "TF-PANIC-01")?.status, "closed");

    const h1 = await desk.toggleManualHalt(true);
    assert.equal(h1.halted, true);
    assert.equal(desk.state.halted, true);

    const h2 = await desk.toggleManualHalt(false);
    assert.equal(h2.halted, false);
    assert.equal(desk.state.halted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SentinelAgent halts execution on >150ms 3-tick RTT, throttles >85% bucket, and fires FATAL_DESYNC", async () => {
  const sentinel = new SentinelAgent(1000);
  sentinel.recordRtt(160);
  sentinel.recordRtt(170);
  const r3 = sentinel.recordRtt(180);
  assert.equal(r3.latencyHalted, true);
  assert.equal(r3.ledStatus, "RED");
  assert.equal(r3.event, "EXECUTION_HALTED_LATENCY");

  sentinel.recordRtt(40);
  sentinel.recordRtt(40);
  const rec = sentinel.recordRtt(45);
  assert.equal(rec.latencyHalted, false);
  assert.equal(rec.ledStatus, "GREEN");

  const limiter = new TokenBucketRateLimiter(1000);
  limiter.recordUsage(860);
  assert.equal(limiter.canExecute("NON_CRITICAL", 10).allowed, false);
  assert.equal(limiter.canExecute("CRITICAL", 10).allowed, true);

  const desyncDrop = sentinel.checkFatalDesync({
    riskManagerOnline: true,
    streamGapMs: 100,
    prevEquity: 10_000,
    currentEquity: 8_200,
  });
  assert.equal(desyncDrop.fatal, true);

  let exitCode: number | null = null;
  let liquidated = false;
  await sentinel.executeCircuitBreaker(
    async () => { liquidated = true; },
    (c) => { exitCode = c; },
  );
  assert.equal(liquidated, true);
  assert.equal(exitCode, 1);
});

test("LiquidityHunterAgent detects spoofing <500ms, squeeze signals, and liquidation magnet zones", () => {
  const hunter = new LiquidityHunterAgent();
  const t0 = 1_700_000_000_000;
  // Wall > 50x avgVolume (avgVolume = 10 -> 600 > 500) appears at t0
  hunter.analyzeOrderBook("BTCUSDT", 90_000, [[89_900, 600], [89_800, 20]], [[90_100, 15]], 10, t0);
  // Vanishes 250ms later without price touching 89,900
  const res = hunter.analyzeOrderBook("BTCUSDT", 90_000, [[89_800, 20]], [[90_100, 15]], 10, t0 + 250);
  assert.equal(res.newSpoofs.length, 1);
  assert.equal(hunter.isSpoofedLevel("BTCUSDT", 89_900, t0 + 500), true);

  const sqLong = hunter.computeSqueezeSignal(0.0003, 0.02, 0.0005);
  assert.equal(sqLong?.signal, "HIGH_PROBABILITY_LONG_SQUEEZE");
  assert.equal(sqLong?.bias, "short");

  const sqShort = hunter.computeSqueezeSignal(-0.0003, 0.02, -0.0005);
  assert.equal(sqShort?.signal, "HIGH_PROBABILITY_SHORT_SQUEEZE");
  assert.equal(sqShort?.bias, "long");
});

test("Mt5CloudBridge maps symbols for mobile MT5 & TelegramFloorRoom supports single-bot relay", () => {
  const dir = mkdtempSync(join(tmpdir(), "tf-v3-mobile-"));
  try {
    assert.equal(Mt5CloudBridge.mapSymbolToMt5("BTCUSDT"), "BTCUSD");
    assert.equal(Mt5CloudBridge.mapSymbolToMt5("NQ1!"), "USTEC");
    assert.equal(Mt5CloudBridge.mapSymbolToMt5("EURUSD"), "EURUSD");

    const bridgePayload = Mt5CloudBridge.buildLocalBridgePayload(
      [
        { id: "TF-01", asset: "BTCUSDT", direction: "long", status: "open", invalidation: 88000, target: 94000 },
        { id: "TF-02", asset: "ETHUSDT", direction: "short", status: "closed", invalidation: 3500, target: 3000 },
      ],
      0.02,
    );
    assert.equal(bridgePayload.openOrders.length, 1);
    assert.equal(bridgePayload.openOrders[0].symbol, "BTCUSD");
    assert.equal(bridgePayload.openOrders[0].side, "BUY");
    assert.equal(bridgePayload.openOrders[0].lots, 0.02);

    const ea = Mt5CloudBridge.generateMql5ExpertAdvisor("http://localhost:4080");
    assert.ok(ea.includes("WebRequest"));
    assert.ok(ea.includes("/api/mt5-bridge/poll"));

    const cfg = makeTestCfg(dir);
    const tg = new TelegramFloorRoom(cfg);
    assert.equal(tg.hasTokens(), false);
    tg.updateCredentials({ chatId: "123456789", tokens: { lead: "99999:TESTTOKEN" } });
    assert.equal(tg.hasTokens(), true);
    assert.equal(tg.configuredBotCount(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DASHBOARD_HTML compiles inline JS cleanly and renders 8 agents & all 5 V3 UI tabs", () => {
  for (const id of ["view-desk", "view-chat", "view-charts", "view-journal", "view-strategy", "mobileDrawer"]) {
    assert.ok(DASHBOARD_HTML.includes(`id="${id}"`), `Missing panel ${id}`);
  }
  for (const needle of [
    "CLOSE ALL POSITIONS",
    "HALT DESK",
    "Entraînement de l'IA (Machine Learning)",
    "Avantage Stratégique (Â)",
    "Stabilité d&#39;Apprentissage (KL)",
    "Qualité du Risque (Sharpe)",
    "# sys-ops",
    "# liquidity-l2",
    "The Sentinel",
    "Liquidity Hunter",
    "Mode Simple 1-Clic",
    "TradingFloorBridge.mq5",
    'max="500"',
    'data-theme="obsidian"',
  ]) {
    assert.ok(DASHBOARD_HTML.includes(needle), `Missing UI element: ${needle}`);
  }
  const m = DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  assert.ok(m && m[1], "Expected main inline script tag");
  assert.doesNotThrow(() => new Function(m[1]));
});

test("Phase 2-5: 20 themes, TradingView tools, ATR mini-chart, and dynamic risk/TP modes", () => {
  // Check 20 themes catalog
  for (const themeKey of ["obsidian", "midnight", "carbon", "nordic", "imperial-gold", "cyberpunk", "swiss-light", "crystal-glass"]) {
    assert.ok(DASHBOARD_HTML.includes(`label: `) && DASHBOARD_HTML.includes(themeKey), `Expected theme ${themeKey}`);
  }

  // Check timeframe strip & drawing tools
  for (const tf of ["1s", "1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]) {
    assert.ok(DASHBOARD_HTML.includes(`id: '${tf}'`), `Expected timeframe ${tf}`);
  }
  for (const tool of ["select", "trendline", "hline", "vline", "channel", "rect", "zone", "fib", "arrow", "text", "measure"]) {
    assert.ok(DASHBOARD_HTML.includes(`data-tool="${tool}"`), `Expected drawing tool ${tool}`);
  }

  // Check beginner-friendly risk & ATR controls
  assert.ok(DASHBOARD_HTML.includes("atrMiniChartSvg"), "Expected ATR mini chart SVG");
  assert.ok(DASHBOARD_HTML.includes("badgeLevLevel"), "Expected leverage level badge");
  assert.ok(DASHBOARD_HTML.includes("liveRiskSummaryBox"), "Expected live risk summary calculator");
  assert.ok(DASHBOARD_HTML.includes("dangerRiskModal"), "Expected danger risk confirmation modal");

  // Verify computeLeveragedSizing with custom riskMode & TP calculations
  const dir = mkdtempSync(join(tmpdir(), "tf-v3-phase-"));
  try {
    const store = new DeskStore(dir);
    const state = store.loadOrCreate(10_000, "Europe/Paris", ["BTCUSDT"], 15);
    state.settings.riskMode = "pct";
    state.settings.maxRiskPct = 0.02;

    const sizingPct = computeLeveragedSizing(state, 100, 95, undefined, {
      side: "long",
      leverageFactor: 5,
    });
    assert.equal(sizingPct.ok, true);
    assert.ok((sizingPct.notional ?? 0) > 0);

    state.settings.riskMode = "amount";
    state.settings.riskAmount = 150;
    const sizingAmt = computeLeveragedSizing(state, 100, 95, undefined, {
      side: "long",
      leverageFactor: 5,
    });
    assert.equal(sizingAmt.ok, true);
    assert.equal(sizingAmt.riskCapital, 150);

    // Test unlocked risk & SL in euros (e.g. 500 EUR risk without 3% cap)
    state.settings.riskMode = "amount";
    state.settings.riskAmount = 500;
    state.settings.slMode = "amount";
    state.settings.slVal = 500;
    state.settings.tpMode = "amount";
    state.settings.tpVal = 1000;
    const sizingUnlocked = computeLeveragedSizing(state, 100, 95, undefined, {
      side: "long",
      leverageFactor: 5,
    });
    assert.equal(sizingUnlocked.ok, true);
    assert.equal(sizingUnlocked.riskCapital, 500);

    // Verify UI contains unlocked SL and TP presets and inputs
    assert.ok(DASHBOARD_HTML.includes("cfgSlAmount"), "Expected cfgSlAmount input");
    assert.ok(DASHBOARD_HTML.includes("setQuickSlAmount"), "Expected setQuickSlAmount helper");
    assert.ok(DASHBOARD_HTML.includes("setQuickRiskAmount"), "Expected setQuickRiskAmount helper");
    assert.ok(DASHBOARD_HTML.includes("setQuickTpAmount"), "Expected setQuickTpAmount helper");

    // Verify Mt5CloudBridge dynamic lot sizing for 100K accounts and leveraged notionals
    const gbpLots = Mt5CloudBridge.computeAssetLots("GBPUSD", 400_000, 1.32);
    assert.ok(gbpLots >= 3.0 && gbpLots <= 4.0, `Expected ~3.03 lots for 400k GBPUSD, got ${gbpLots}`);

    const goldLots = Mt5CloudBridge.computeAssetLots("XAUUSD", 200_000, 3864);
    assert.ok(goldLots >= 0.5 && goldLots <= 0.6, `Expected ~0.52 lot for 200k Gold, got ${goldLots}`);

    const tslaLots = Mt5CloudBridge.computeAssetLots("TSLA", 18_000, 377);
    assert.ok(tslaLots >= 45 && tslaLots <= 50, `Expected ~47.7 lots for 18k TSLA shares, got ${tslaLots}`);

    // Verify buildLocalBridgePayload does not collapse to 0.01 lot when notional is present
    const bridgePayload = Mt5CloudBridge.buildLocalBridgePayload([
      {
        id: "T-1",
        asset: "GBPUSD",
        direction: "long",
        status: "open",
        entry: 1.32,
        invalidation: 1.31,
        target: 1.34,
        notional: 400_000,
      }
    ]);
    assert.equal(bridgePayload.ok, true);
    assert.ok(bridgePayload.openOrders[0].lots >= 3.0, `Expected order lots >= 3.0, got ${bridgePayload.openOrders[0].lots}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
