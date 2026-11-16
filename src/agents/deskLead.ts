import type { AggressivenessState, SessionGoal } from "../types.ts";

export class PacingCalculator {
  /**
   * Calculates required and current PnL velocity tick-by-tick
   */
  static calculate(
    goal: SessionGoal,
    currentEquity: number,
    realizedPnl: number,
    now = Date.now(),
  ): {
    currentProfitFiat: number;
    remainingProfitFiat: number;
    remainingHours: number;
    elapsedHours: number;
    requiredVelocityPerHour: number;
    currentVelocityPerHour: number;
    aggressiveness: AggressivenessState;
    statusLabel: string;
    actionEvent?: "INCREASE_AGGRESSIVENESS" | "REDUCE_RISK" | "SECURE_PROFITS" | "MAINTAIN_PACE";
  } {
    // Profit since session start
    const equityGain = currentEquity - goal.startEquity;
    const currentProfitFiat = Number((equityGain + realizedPnl).toFixed(2));
    const remainingProfitFiat = Number((goal.targetProfitFiat - currentProfitFiat).toFixed(2));

    const remainingMs = Math.max(0, goal.deadlineTimestamp - now);
    const remainingHours = Math.max(0.01, remainingMs / 3_600_000);
    const elapsedMs = Math.max(1_000, now - goal.startedAt);
    const elapsedHours = Math.max(0.01, elapsedMs / 3_600_000);

    const requiredVelocityPerHour = Number(
      (remainingProfitFiat > 0 ? remainingProfitFiat / remainingHours : 0).toFixed(2),
    );
    const currentVelocityPerHour = Number((currentProfitFiat / elapsedHours).toFixed(2));

    let aggressiveness: AggressivenessState = "normal";
    let statusLabel = "SUR LA TRAJECTOIRE";
    let actionEvent: "INCREASE_AGGRESSIVENESS" | "REDUCE_RISK" | "SECURE_PROFITS" | "MAINTAIN_PACE" = "MAINTAIN_PACE";

    if (currentProfitFiat >= goal.targetProfitFiat) {
      aggressiveness = "target_reached";
      statusLabel = "OBJECTIF ATTEINT - CAPITAL SÉCURISÉ";
      actionEvent = "SECURE_PROFITS";
    } else if (remainingMs <= 0) {
      aggressiveness = "secured";
      statusLabel = "ÉCHÉANCE EXPIRÉE - PROTECTION CAPITAL";
      actionEvent = "REDUCE_RISK";
    } else if (
      currentVelocityPerHour < requiredVelocityPerHour * 0.75 ||
      currentProfitFiat < (goal.targetProfitFiat * (elapsedHours / (elapsedHours + remainingHours))) * 0.8
    ) {
      aggressiveness = "lagging_aggressive";
      statusLabel = "EN RETARD - AGRESSIVITÉ MAX ENGAGÉE";
      actionEvent = "INCREASE_AGGRESSIVENESS";
    } else if (currentVelocityPerHour >= requiredVelocityPerHour * 1.3) {
      aggressiveness = "normal";
      statusLabel = "EN AVANCE - RISQUE MODÉRÉ";
      actionEvent = "REDUCE_RISK";
    }

    return {
      currentProfitFiat,
      remainingProfitFiat,
      remainingHours,
      elapsedHours,
      requiredVelocityPerHour,
      currentVelocityPerHour,
      aggressiveness,
      statusLabel,
      actionEvent,
    };
  }
}

export class DeskLeadAgent {
  /**
   * Initializes or refreshes an autonomous financial session goal
   */
  static createSessionGoal(
    startEquity: number,
    targetProfitFiat = 2000,
    durationHours = 4,
    now = Date.now(),
  ): SessionGoal {
    const deadlineTimestamp = now + durationHours * 3600 * 1000;
    return {
      targetProfitFiat,
      deadlineTimestamp,
      startEquity,
      startedAt: now,
      requiredVelocityPerHour: Number((targetProfitFiat / durationHours).toFixed(2)),
      currentVelocityPerHour: 0,
      currentProfitFiat: 0,
      aggressiveness: "normal",
      statusLabel: "INITIALISÉ - OBJECTIF EN COURS",
    };
  }

  /**
   * Adjusts global risk appetite multiplier based on recent alpha decay
   * (rolling win-rate & R-multiple decay across closed trades).
   */
  static computeAlphaDecayRiskMultiplier(recentPnls: number[]): {
    multiplier: number;
    alphaDecayDetected: boolean;
    reason: string;
  } {
    if (recentPnls.length < 4) {
      return { multiplier: 1.0, alphaDecayDetected: false, reason: "Échantillon insuffisant (<4 trades)" };
    }
    const lastWindow = recentPnls.slice(-8);
    const prevWindow = recentPnls.slice(-16, -8);
    const avgLast = lastWindow.reduce((a, b) => a + b, 0) / lastWindow.length;
    const avgPrev = prevWindow.length ? prevWindow.reduce((a, b) => a + b, 0) / prevWindow.length : avgLast;

    if (avgLast < 0 && avgLast < avgPrev * 0.7) {
      return {
        multiplier: 0.6,
        alphaDecayDetected: true,
        reason: `Alpha Decay détecté (moy=${avgLast.toFixed(1)}$ vs ${avgPrev.toFixed(1)}$) -> Appétit au risque réduit à 0.60x.`,
      };
    }
    if (avgLast > 0 && avgLast >= avgPrev) {
      return {
        multiplier: 1.25,
        alphaDecayDetected: false,
        reason: `Alpha en expansion (moy=${avgLast.toFixed(1)}$) -> Appétit au risque relevé à 1.25x.`,
      };
    }
    return { multiplier: 1.0, alphaDecayDetected: false, reason: "Alpha stable (1.00x)." };
  }

  /**
   * Tick-by-tick evaluation of pacing and state transitions
   */
  static evaluateTick(
    goal: SessionGoal,
    currentEquity: number,
    realizedPnl: number,
    now = Date.now(),
  ): {
    updatedGoal: SessionGoal;
    event?: "INCREASE_AGGRESSIVENESS" | "REDUCE_RISK" | "SECURE_PROFITS" | "MAINTAIN_PACE";
  } {
    const calc = PacingCalculator.calculate(goal, currentEquity, realizedPnl, now);

    const updatedGoal: SessionGoal = {
      ...goal,
      currentProfitFiat: calc.currentProfitFiat,
      requiredVelocityPerHour: calc.requiredVelocityPerHour,
      currentVelocityPerHour: calc.currentVelocityPerHour,
      aggressiveness: calc.aggressiveness,
      statusLabel: calc.statusLabel,
    };

    return {
      updatedGoal,
      event: calc.actionEvent,
    };
  }
}
