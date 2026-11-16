import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlayKind } from "../types.ts";

export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "MEAN_REVERTING" | "HIGH_VOL_CASCADE";

export type StrategyWeights = Record<PlayKind, number>;

export type HyperparameterDist = {
  slMultMean: number;
  slMultStd: number;
  tpMultMean: number;
  tpMultStd: number;
  leverageMean: number;
  leverageStd: number;
};

export type CandidateActionConfig = {
  id: string;
  strategy: PlayKind;
  slMult: number;
  tpMult: number;
  leverage: number;
  probOld: number;
};

export type GrpoObservationState = {
  regime: MarketRegime;
  volatility: number;
  ofiZScore: number;
  vwapZScore: number;
  fvgProximity: number;
  macroSurprise: number;
  socialScore: number;
};

export type GrpoCandidateOutcome = {
  config: CandidateActionConfig;
  pnl: number;
  realizedR: number;
  maxAdverseExcursion: number;
  stopDistance: number;
  executionFees: number;
};

export type GrpoUpdateResult = {
  regime: MarketRegime;
  groupSize: number;
  rewards: number[];
  advantages: number[];
  meanReward: number;
  meanAdvantage: number;
  klDivergence: number;
  updatedWeights: StrategyWeights;
  updatedHyperparams: HyperparameterDist;
  selectedStrategy: PlayKind;
};

export type HistoricalAdvantageEntry = {
  at: number;
  episode: number;
  regime: MarketRegime;
  meanReward: number;
  meanAdvantage: number;
  klDivergence: number;
  selectedStrategy: PlayKind;
};

export type RlPolicyMemory = {
  version: number;
  timestamp: number;
  regimeWeights: Record<MarketRegime, StrategyWeights>;
  referenceWeights: Record<MarketRegime, StrategyWeights>;
  hyperparameterDistributions: Record<MarketRegime, HyperparameterDist>;
  historicalAdvantageLog: HistoricalAdvantageEntry[];
  totalEpisodes: number;
};

export type ReviewerDiagnosticEntry = {
  at: number;
  ticketId: string;
  symbol: string;
  regime: MarketRegime;
  strategy: PlayKind;
  realizedPnl: number;
  realizedR: number;
  advantageShift: number;
  klDivergence: number;
  winningFeatures: string[];
  losingFeatures: string[];
  parameterAdjustments: string;
  markdown: string;
};

const STRATEGIES: PlayKind[] = [
  "HFT_OrderFlow_Imbalance",
  "Session_VWAP_Reversion",
  "Macro_FVG_Mitigation",
  "HFT_Kamikaze_FiatTarget",
  "breakout",
  "fade",
];

function defaultStrategyWeights(): StrategyWeights {
  return {
    HFT_OrderFlow_Imbalance: 0.2,
    Session_VWAP_Reversion: 0.2,
    Macro_FVG_Mitigation: 0.2,
    HFT_Kamikaze_FiatTarget: 0.2,
    breakout: 0.1,
    fade: 0.1,
  };
}

function defaultHyperDist(): HyperparameterDist {
  return {
    slMultMean: 1.35,
    slMultStd: 0.25,
    tpMultMean: 2.0,
    tpMultStd: 0.35,
    leverageMean: 5,
    leverageStd: 2,
  };
}

function createInitialMemory(now = Date.now()): RlPolicyMemory {
  const regimes: MarketRegime[] = ["TRENDING_UP", "TRENDING_DOWN", "MEAN_REVERTING", "HIGH_VOL_CASCADE"];
  const regimeWeights = {} as Record<MarketRegime, StrategyWeights>;
  const referenceWeights = {} as Record<MarketRegime, StrategyWeights>;
  const hyperparameterDistributions = {} as Record<MarketRegime, HyperparameterDist>;

  for (const r of regimes) {
    regimeWeights[r] = defaultStrategyWeights();
    referenceWeights[r] = defaultStrategyWeights();
    hyperparameterDistributions[r] = defaultHyperDist();
  }
  // Regime priors
  regimeWeights.HIGH_VOL_CASCADE.fade = 0.35;
  regimeWeights.HIGH_VOL_CASCADE.Macro_FVG_Mitigation = 0.30;
  regimeWeights.HIGH_VOL_CASCADE.breakout = 0.05;
  regimeWeights.MEAN_REVERTING.Session_VWAP_Reversion = 0.36;
  regimeWeights.TRENDING_UP.Macro_FVG_Mitigation = 0.28;
  regimeWeights.TRENDING_DOWN.Macro_FVG_Mitigation = 0.28;

  return {
    version: 3,
    timestamp: now,
    regimeWeights,
    referenceWeights,
    hyperparameterDistributions,
    historicalAdvantageLog: [],
    totalEpisodes: 0,
  };
}

function softmax(logits: Record<PlayKind, number>): StrategyWeights {
  const maxL = Math.max(...STRATEGIES.map((s) => logits[s]));
  const exps = {} as StrategyWeights;
  let sum = 0;
  for (const s of STRATEGIES) {
    const e = Math.exp(logits[s] - maxL);
    exps[s] = e;
    sum += e;
  }
  const out = {} as StrategyWeights;
  for (const s of STRATEGIES) {
    out[s] = Math.max(0.02, exps[s] / Math.max(sum, 1e-12));
  }
  const norm = STRATEGIES.reduce((a, s) => a + out[s], 0);
  for (const s of STRATEGIES) out[s] /= norm;
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function gaussianNoise(seed: number): number {
  const u1 = Math.max(1e-7, ((Math.sin(seed * 12.9898) * 43758.5453) % 1 + 1) % 1);
  const u2 = ((Math.sin(seed * 78.233) * 19341.123) % 1 + 1) % 1;
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export class GrpoEngine {
  readonly memoryPath: string;
  readonly reviewerLogPath: string;
  memory: RlPolicyMemory;

  // GRPO hyperparameters
  private readonly epsilon = 0.2;
  private readonly betaKl = 0.04;
  private readonly lr = 0.08;
  private readonly alpha = 0.35;
  private readonly betaMae = 0.45;
  private readonly gammaFees = 0.02;

  constructor(memoryPath = "./data/rl_policy_memory.json", reviewerLogPath = "./logs/reviewer_reports.json") {
    this.memoryPath = memoryPath;
    this.reviewerLogPath = reviewerLogPath;
    this.memory = this.loadMemory();
  }

  loadMemory(): RlPolicyMemory {
    try {
      if (existsSync(this.memoryPath)) {
        const parsed = JSON.parse(readFileSync(this.memoryPath, "utf8")) as RlPolicyMemory;
        if (parsed && parsed.regimeWeights && parsed.hyperparameterDistributions) {
          return parsed;
        }
      }
    } catch {
      const bak = `${this.memoryPath}.bak`;
      if (existsSync(bak)) {
        try {
          return JSON.parse(readFileSync(bak, "utf8")) as RlPolicyMemory;
        } catch {
          // fall through
        }
      }
    }
    const fresh = createInitialMemory();
    this.memory = fresh;
    this.saveMemoryAtomic();
    return fresh;
  }

  saveMemoryAtomic(): void {
    mkdirSync(dirname(this.memoryPath), { recursive: true });
    if (existsSync(this.memoryPath)) {
      try {
        copyFileSync(this.memoryPath, `${this.memoryPath}.bak`);
      } catch {
        // ignore backup error
      }
    }
    const tmp = `${this.memoryPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.memory, null, 2), "utf8");
    renameSync(tmp, this.memoryPath);
  }

  hotReload(): RlPolicyMemory {
    this.memory = this.loadMemory();
    return this.memory;
  }

  classifyRegime(obs: {
    ret24h: number;
    cascadeActive: boolean;
    atrPct: number;
  }): MarketRegime {
    if (obs.cascadeActive || obs.atrPct > 0.045) return "HIGH_VOL_CASCADE";
    if (obs.ret24h > 0.015) return "TRENDING_UP";
    if (obs.ret24h < -0.015) return "TRENDING_DOWN";
    return "MEAN_REVERTING";
  }

  /**
   * Sample a group of G candidate action configurations {o_1, ..., o_G} around current policy distributions.
   */
  sampleCandidateGroup(state: GrpoObservationState, groupSize = 8, seedBase = Date.now()): CandidateActionConfig[] {
    const weights = this.memory.regimeWeights[state.regime] ?? defaultStrategyWeights();
    const dist = this.memory.hyperparameterDistributions[state.regime] ?? defaultHyperDist();
    const candidates: CandidateActionConfig[] = [];

    for (let i = 0; i < groupSize; i++) {
      const strat = STRATEGIES[i % STRATEGIES.length];
      const n1 = gaussianNoise(seedBase + i * 17 + 1);
      const n2 = gaussianNoise(seedBase + i * 31 + 2);
      const n3 = gaussianNoise(seedBase + i * 47 + 3);

      const slMult = clamp(dist.slMultMean + n1 * dist.slMultStd, 0.5, 3.0);
      const tpMult = clamp(dist.tpMultMean + n2 * dist.tpMultStd, 1.2, 4.0);
      const leverage = Math.round(clamp(dist.leverageMean + n3 * dist.leverageStd, 1, 50));
      const probOld = Math.max(0.02, weights[strat] ?? 0.2);

      candidates.push({
        id: `o_${i + 1}`,
        strategy: strat,
        slMult,
        tpMult,
        leverage,
        probOld,
      });
    }
    return candidates;
  }

  /**
   * Composite Reward Function:
   * R(o_i) = sign(PnL) + alpha * clamp(RealizedR, -3, +5) - beta * (MAE / StopDistance) - gamma * ExecutionFees
   */
  computeCompositeReward(outcome: GrpoCandidateOutcome): number {
    const baseSign = outcome.pnl > 0 ? 1.0 : outcome.pnl < 0 ? -1.0 : outcome.realizedR > 0 ? 1.0 : -1.0;
    const clampedR = clamp(outcome.realizedR, -3, 5);
    const maePenalty = outcome.maxAdverseExcursion / Math.max(outcome.stopDistance, 1e-9);
    const feePenalty = Math.max(0, outcome.executionFees);
    return baseSign + this.alpha * clampedR - this.betaMae * clamp(maePenalty, 0, 2.5) - this.gammaFees * feePenalty;
  }

  /**
   * Perform full GRPO policy update across group outcomes {o_1, ..., o_G}
   * with PPO/GRPO clipping (epsilon = 0.2) and KL-divergence regularization (beta_KL = 0.04) vs W_ref.
   */
  updatePolicyFromGroup(regime: MarketRegime, outcomes: GrpoCandidateOutcome[]): GrpoUpdateResult {
    const G = Math.max(1, outcomes.length);
    const rewards = outcomes.map((o) => this.computeCompositeReward(o));
    const muR = rewards.reduce((a, b) => a + b, 0) / G;
    const varR = rewards.reduce((a, r) => a + (r - muR) ** 2, 0) / G;
    const sigmaR = Math.sqrt(varR + 1e-8);
    const advantages = rewards.map((r) => (r - muR) / sigmaR);

    const curWeights = { ...(this.memory.regimeWeights[regime] ?? defaultStrategyWeights()) };
    const refWeights = this.memory.referenceWeights[regime] ?? defaultStrategyWeights();
    const curDist = { ...(this.memory.hyperparameterDistributions[regime] ?? defaultHyperDist()) };

    // Convert current weights to logits for softmax policy gradient update
    const logits = {} as Record<PlayKind, number>;
    for (const s of STRATEGIES) {
      logits[s] = Math.log(Math.max(0.02, curWeights[s]));
    }

    // KL(pi || pi_ref) = sum pi(s) * log(pi(s) / pi_ref(s))
    let klDivergence = 0;
    for (const s of STRATEGIES) {
      const p = Math.max(0.02, curWeights[s]);
      const pRef = Math.max(0.02, refWeights[s]);
      klDivergence += p * Math.log(p / pRef);
    }

    let slWeightedDelta = 0;
    let tpWeightedDelta = 0;
    let levWeightedDelta = 0;

    for (let i = 0; i < outcomes.length; i++) {
      const o = outcomes[i];
      const A_i = advantages[i];
      const s = o.config.strategy;
      const pNew = Math.max(0.02, curWeights[s]);
      const pOld = Math.max(0.02, o.config.probOld);
      const ratio = pNew / pOld;
      const clippedRatio = clamp(ratio, 1 - this.epsilon, 1 + this.epsilon);
      const surrogateGrad = A_i >= 0 ? Math.min(ratio * A_i, clippedRatio * A_i) : Math.max(ratio * A_i, clippedRatio * A_i);

      const pRef = Math.max(0.02, refWeights[s]);
      const klGrad = Math.log(pNew / pRef) + 1;

      logits[s] += this.lr * (surrogateGrad - this.betaKl * klGrad);

      const normWeight = A_i / G;
      slWeightedDelta += normWeight * (o.config.slMult - curDist.slMultMean);
      tpWeightedDelta += normWeight * (o.config.tpMult - curDist.tpMultMean);
      levWeightedDelta += normWeight * (o.config.leverage - curDist.leverageMean);
    }

    const updatedWeights = softmax(logits);
    curDist.slMultMean = clamp(curDist.slMultMean + this.lr * slWeightedDelta, 0.6, 2.8);
    curDist.tpMultMean = clamp(curDist.tpMultMean + this.lr * tpWeightedDelta, 1.3, 3.8);
    curDist.leverageMean = clamp(curDist.leverageMean + this.lr * 2.5 * levWeightedDelta, 1, 50);

    // Compute updated KL divergence
    let postKl = 0;
    for (const s of STRATEGIES) {
      const p = Math.max(0.02, updatedWeights[s]);
      const pRef = Math.max(0.02, refWeights[s]);
      postKl += p * Math.log(p / pRef);
    }

    this.memory.regimeWeights[regime] = updatedWeights;
    this.memory.hyperparameterDistributions[regime] = curDist;
    this.memory.totalEpisodes += 1;
    this.memory.timestamp = Date.now();

    const selectedStrategy = STRATEGIES.reduce((best, s) => (updatedWeights[s] > updatedWeights[best] ? s : best), STRATEGIES[0]);
    const meanAdvantage = advantages.reduce((a, b) => a + b, 0) / G;

    this.memory.historicalAdvantageLog = [
      ...this.memory.historicalAdvantageLog.slice(-199),
      {
        at: this.memory.timestamp,
        episode: this.memory.totalEpisodes,
        regime,
        meanReward: muR,
        meanAdvantage,
        klDivergence: postKl,
        selectedStrategy,
      },
    ];

    this.saveMemoryAtomic();

    return {
      regime,
      groupSize: G,
      rewards,
      advantages,
      meanReward: muR,
      meanAdvantage,
      klDivergence: postKl,
      updatedWeights,
      updatedHyperparams: curDist,
      selectedStrategy,
    };
  }

  /**
   * Trade Reviewer structured Markdown/JSON diagnostic saved atomically to ./logs/reviewer_reports.json
   */
  appendReviewerDiagnostic(entry: Omit<ReviewerDiagnosticEntry, "markdown">): ReviewerDiagnosticEntry {
    const markdown = [
      `### Post-Mortem Diagnostic — ${entry.ticketId} (${entry.symbol})`,
      `- **Regime:** \`${entry.regime}\` | **Strategy:** \`${entry.strategy}\``,
      `- **Result:** PnL \`$${entry.realizedPnl.toFixed(2)}\` | R-Multiple: \`${entry.realizedR.toFixed(2)}R\``,
      `- **GRPO Shift:** Advantage $\\bar{A}=${entry.advantageShift.toFixed(3)}$ | KL-Divergence: \`${entry.klDivergence.toFixed(4)}\``,
      `- **Winning Features:** ${entry.winningFeatures.join(", ") || "None"}`,
      `- **Losing Features:** ${entry.losingFeatures.join(", ") || "None"}`,
      `- **Parameter Adjustments:** ${entry.parameterAdjustments}`,
    ].join("\n");

    const fullEntry: ReviewerDiagnosticEntry = { ...entry, markdown };
    mkdirSync(dirname(this.reviewerLogPath), { recursive: true });
    let existing: ReviewerDiagnosticEntry[] = [];
    if (existsSync(this.reviewerLogPath)) {
      try {
        existing = JSON.parse(readFileSync(this.reviewerLogPath, "utf8")) as ReviewerDiagnosticEntry[];
      } catch {
        existing = [];
      }
    }
    const updated = [fullEntry, ...existing].slice(0, 300);
    const tmp = `${this.reviewerLogPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(updated, null, 2), "utf8");
    renameSync(tmp, this.reviewerLogPath);
    return fullEntry;
  }

  getStrategyWeight(regime: MarketRegime, strategy: PlayKind): number {
    return this.memory.regimeWeights[regime]?.[strategy] ?? 0.2;
  }

  getRecommendedHyperparams(regime: MarketRegime): HyperparameterDist {
    return this.memory.hyperparameterDistributions[regime] ?? defaultHyperDist();
  }
}

export function defaultDataPath(fileName: string): string {
  return join(".", "data", fileName);
}
