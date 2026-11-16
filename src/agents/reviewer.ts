import type { GrpoCandidateOutcome, GrpoEngine, GrpoObservationState, MarketRegime } from "../rl/grpo.ts";
import type { PlayKind, Ticket } from "../types.ts";

export type TradeReviewOutput = {
  ticketId: string;
  asset: string;
  netPnl: number;
  rMultiple: number;
  grade: "A+" | "A" | "B" | "C";
  grpoUpdated: boolean;
  summary: string;
};

export class ReviewerAgent {
  /**
   * Ingests a closed trade, computes exact R-Multiple, assigns a setup grade,
   * and updates the GRPO reinforcement learning state vector.
   */
  static reviewClosedTrade(
    ticket: Ticket,
    grpo: GrpoEngine,
    ctx: GrpoObservationState,
    siblingOutcomes: GrpoCandidateOutcome[] = [],
  ): TradeReviewOutput {
    const netPnl = ticket.pnl ?? 0;
    const riskUsd = Math.max(1e-6, ticket.riskUsd || 1);
    const rMultiple = Number((netPnl / riskUsd).toFixed(4));

    const grade: "A+" | "A" | "B" | "C" =
      rMultiple >= 2.0 ? "A+" : rMultiple >= 0.5 ? "A" : rMultiple >= -0.5 ? "B" : "C";

    const engineName = (ticket.engine ?? ticket.playbook) as PlayKind;
    const stopDist = Math.abs(ticket.entry - ticket.invalidation) / Math.max(ticket.entry, 1e-9);

    const outcome: GrpoCandidateOutcome = {
      config: {
        id: ticket.id,
        strategy: engineName,
        slMult: 1.35,
        tpMult: 2.0,
        leverage: ticket.leverage ?? 1,
        probOld: grpo.getStrategyWeight((ticket.regime as MarketRegime) || ctx.regime, engineName),
      },
      pnl: netPnl,
      realizedR: rMultiple,
      maxAdverseExcursion: ticket.maxAdverseExcursion ?? 0,
      stopDistance: stopDist,
      executionFees: ticket.fees ?? 0,
    };

    const group = siblingOutcomes.length ? [outcome, ...siblingOutcomes] : [outcome];
    grpo.updatePolicyFromGroup((ticket.regime as MarketRegime) || ctx.regime, group);

    return {
      ticketId: ticket.id,
      asset: ticket.asset,
      netPnl: Number(netPnl.toFixed(2)),
      rMultiple,
      grade,
      grpoUpdated: true,
      summary: `Audit ${ticket.id} (${ticket.asset} ${ticket.direction.toUpperCase()}) : PnL=${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)}$, R=${rMultiple >= 0 ? "+" : ""}${rMultiple.toFixed(2)}R, Grade=${grade} -> GRPO mis à jour.`,
    };
  }
}
