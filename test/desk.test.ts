import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeQuantMetrics, optimizeParametersOnHistory, runBacktestOnBars } from "../src/backtest.ts";
import { loadConfig } from "../src/config.ts";
import { sizeTradeIdea, TradingFloorDesk } from "../src/desk.ts";
import { DeskStore } from "../src/store.ts";
import { TelegramFloorRoom } from "../src/telegram.ts";
import type { Kline } from "../src/types.ts";

test("Risk Manager enforces 3% per trade, 10% total exposure, and 5% daily loss halt", () => {
  const tmp = mkdtempSync(join(tmpdir(), "tf-test-"));
  try {
    const cfg = loadConfig(["--console"]);
    cfg.dataDir = tmp;
    const store = new DeskStore(tmp);
    const tg = new TelegramFloorRoom(cfg);
    const desk = new TradingFloorDesk(cfg, store, tg);

    // 1. Tight stop (2% distance) -> 10% max exposure binds before 3% risk
    const s1 = sizeTradeIdea(desk.state, 100, 98);
    assert.equal(s1.ok, true);
    if (s1.ok) {
      assert.equal(s1.binding, "exposure");
      assert.equal(Math.round(s1.notional), 1000); // 10% of $10,000
      assert.ok(s1.riskPct <= 0.03);
    }

    // 2. Wide stop (20% distance) -> 10% exposure cap keeps risk at 2% (<= 3%)
    const s2 = sizeTradeIdea(desk.state, 100, 80);
    assert.equal(s2.ok, true);
    if (s2.ok) {
      assert.ok(s2.exposurePct <= 0.1001);
      assert.ok(s2.riskPct <= 0.0301);
    }

    // 3. When halted, Risk Manager vetoes any new trade
    desk.state.halted = true;
    desk.state.haltKind = "loss";
    const s3 = sizeTradeIdea(desk.state, 100, 95);
    assert.equal(s3.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Strategist 90-day + OOS backtest kills negative-expectancy ideas", () => {
  const flatBars: Kline[] = [];
  const start = Date.now() - 720 * 4 * 3600_000;
  for (let i = 0; i < 720; i++) {
    // Whipsaw mean-reverting noise that fails breakout
    const px = 100 + (i % 2 === 0 ? 2 : -2);
    flatBars.push({
      openTime: start + i * 14400_000,
      open: px,
      high: px + 0.5,
      low: px - 0.5,
      close: px,
      volume: 100,
      closeTime: start + (i + 1) * 14400_000 - 1,
    });
  }
  const bt = runBacktestOnBars(flatBars, "breakout", "test");
  assert.equal(bt.pass, false);
  assert.ok(bt.killReason);
});

test("Execution Trader refuses withdrawal keys & Trade Reviewer refuses deleting losers", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "tf-rules-"));
  try {
    const cfg = loadConfig(["--console"]);
    cfg.dataDir = tmp;
    const store = new DeskStore(tmp);
    const tg = new TelegramFloorRoom(cfg);
    const desk = new TradingFloorDesk(cfg, store, tg);

    await desk.handleHumanInput("offer key with withdrawal permission", "web");
    const lastExec = desk.state.messages[desk.state.messages.length - 1];
    assert.equal(lastExec.speaker, "execution");
    assert.match(lastExec.text, /REFUSÉ/i);

    await desk.handleHumanInput("delete losing trades", "web");
    const lastRev = desk.state.messages[desk.state.messages.length - 1];
    assert.equal(lastRev.speaker, "reviewer");
    assert.match(lastRev.text, /REFUSÉ/i);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Quant metrics (DSR, VaR95, MDD), WFO parameter optimization & Full Auto / Human Confirm toggle", async () => {
  const m = computeQuantMetrics([1.5, -1.0, 2.0, -1.0, 1.8, 1.2, -1.0, 2.1], 10);
  assert.equal(m.trades, 8);
  assert.ok(m.deflatedSharpe >= 0 && m.deflatedSharpe <= 1);
  assert.ok(m.maxDrawdownR >= 1.0);
  assert.ok(m.var95R <= 0);

  // Trending synthetic series to test WFO optimization loop
  const bars: Kline[] = [];
  const start = Date.now() - 300 * 3600_000;
  let px = 100;
  for (let i = 0; i < 300; i++) {
    const delta = i % 7 === 0 ? -0.4 : 0.35;
    const open = px;
    const close = Math.max(10, open + delta);
    bars.push({
      openTime: start + i * 3600_000,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 1000 + (i % 5) * 400,
      closeTime: start + (i + 1) * 3600_000 - 1,
    });
    px = close;
  }

  const opt = optimizeParametersOnHistory("BTCUSDT", bars, {
    ofiZScoreThreshold: 2.5,
    fixedStopAtr: 1.35,
    fvgMinSizeAtr: 0.5,
  });
  assert.equal(opt.strategies.length, 5);
  assert.ok(opt.reason.length > 10);

  const tmp = mkdtempSync(join(tmpdir(), "tf-mode-"));
  try {
    const cfg = loadConfig(["--console"]);
    cfg.dataDir = tmp;
    const store = new DeskStore(tmp);
    const tg = new TelegramFloorRoom(cfg);
    const desk = new TradingFloorDesk(cfg, store, tg);

    assert.equal(desk.state.settings.executionMode, "human_confirm");
    await desk.handleHumanInput("mode auto", "web");
    assert.equal(desk.state.settings.executionMode, "auto");
    await desk.handleHumanInput("mode confirmation", "web");
    assert.equal(desk.state.settings.executionMode, "human_confirm");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
