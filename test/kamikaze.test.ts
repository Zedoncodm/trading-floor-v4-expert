import assert from "node:assert/strict";
import test from "node:test";
import { DeskLeadAgent, PacingCalculator } from "../src/agents/deskLead.ts";
import { RiskManagerAgent } from "../src/agents/riskManager.ts";
import { ExecutionTraderAgent } from "../src/agents/executionTrader.ts";
import { StrategistAgent } from "../src/agents/strategist.ts";
import type { Ticket } from "../src/types.ts";

test("Module 1: Session Goal Manager & Tick-by-Tick PacingCalculator", () => {
  const now = 1_700_000_000_000;
  const startEq = 100_000;
  const targetProfit = 2_000;
  const durationHours = 4;

  const goal = DeskLeadAgent.createSessionGoal(startEq, targetProfit, durationHours, now);
  assert.equal(goal.targetProfitFiat, 2_000);
  assert.equal(goal.requiredVelocityPerHour, 500); // 2000 / 4 = 500 $/h

  // Test lagging pacing: after 2 hours, profit is only $200 (well below $500/h required)
  const laggingTick = now + 2 * 3600 * 1000;
  const { updatedGoal: laggingGoal, event: lagEvent } = DeskLeadAgent.evaluateTick(
    goal,
    startEq + 100,
    100, // total profit = $200
    laggingTick,
  );
  assert.equal(laggingGoal.aggressiveness, "lagging_aggressive");
  assert.equal(lagEvent, "INCREASE_AGGRESSIVENESS");

  // Test goal reached: profit reached $2,100
  const winTick = now + 1.5 * 3600 * 1000;
  const { updatedGoal: winGoal, event: winEvent } = DeskLeadAgent.evaluateTick(
    goal,
    startEq + 1500,
    600, // total profit = $2,100
    winTick,
  );
  assert.equal(winGoal.aggressiveness, "target_reached");
  assert.equal(winEvent, "SECURE_PROFITS");
});

test("Module 1 & 2: Dynamic Concurrency & Reverse-Engineered Position Sizing", () => {
  // Test Dynamic Concurrency
  const normalConcurrency = RiskManagerAgent.calculateDynamicConcurrency(50_000, 100_000, 0.015, "normal", "standard");
  assert.ok(normalConcurrency <= 8);

  // In Kamikaze / High Aggressiveness mode, concurrency expands up to 50 micro-positions
  const kamikazeConcurrency = RiskManagerAgent.calculateDynamicConcurrency(50_000, 100_000, 0.015, "lagging_aggressive", "hft_kamikaze");
  assert.ok(kamikazeConcurrency >= 10 && kamikazeConcurrency <= 50);

  // Test Reverse-Engineered Position Sizing for HFT Fiat-Target ($50-$100 target)
  const currentPrice = 60_000;
  const atr1m = 120; // 1m ATR
  const sizing = RiskManagerAgent.reverseEngineerHftSizing(currentPrice, atr1m, 75, "long", 500, 20_000);

  assert.equal(sizing.ok, true);
  assert.equal(sizing.leverage, 500);
  assert.equal(sizing.expectedPriceMove, 24); // 120 * 0.2 = 24
  assert.ok(sizing.requiredNotional > 0);
  assert.ok(sizing.requiredMargin > 0 && sizing.requiredMargin <= 20_000);
  // Verify that on this 24$ micro-move, the profit is exactly $75
  const expectedProfit = sizing.requiredNotional * (24 / 60_000);
  assert.ok(Math.abs(expectedProfit - 75) < 0.5);
});

test("Module 2: Fiat-Target Take Profit Logic & High Frequency Barrage Trigger", () => {
  // Test instant market close when unrealized PnL is between $50 and $100
  const mockTicket: Ticket = {
    id: "T-KAMIKAZE-1",
    asset: "BTCUSDT",
    direction: "long",
    playbook: "HFT_Kamikaze_FiatTarget",
    thesis: "Kamikaze test",
    entry: 60_000,
    fillPrice: 60_000,
    invalidation: 59_950,
    target: 60_100,
    timeStopHours: 0.05,
    notional: 187_500, // sized to give $75 on a 24$ move
    qty: 3.125,
    riskUsd: 75,
    riskPct: 0.00075,
    exposurePct: 1.875,
    binding: "risk",
    producedBy: ["strategist", "risk"],
    backtest: {} as any,
    status: "open",
    createdAt: Date.now(),
    expiresAt: Date.now() + 180_000,
    fees: 5,
    funding: 0,
  };

  // Price moved up by 25 points -> gross profit = 187,500 * (25 / 60,000) = $78.125 - fees = ~$73.12
  const evalWin = ExecutionTraderAgent.evaluateFiatTargetTakeProfit(mockTicket, 60_025, 50, 100);
  assert.equal(evalWin.shouldClose, true);
  assert.ok(evalWin.unrealizedPnl >= 50 && evalWin.unrealizedPnl <= 100);

  // Price moved down -> should not close
  const evalLoss = ExecutionTraderAgent.evaluateFiatTargetTakeProfit(mockTicket, 59_995, 50, 100);
  assert.equal(evalLoss.shouldClose, false);

  // Test Strategist HFT Barrage Entry Trigger based on L2 imbalance
  const triggerLong = StrategistAgent.evaluateHftBarrageEntry(
    "BTCUSDT",
    60_000,
    60_001,
    0.35, // Strong buyer imbalance in orderbook
    1.2,  // Strong positive OFI
    120,
    "lagging_aggressive",
    "hft_kamikaze",
  );
  assert.ok(triggerLong !== null);
  assert.equal(triggerLong.trigger, true);
  assert.equal(triggerLong.side, "long");
});
