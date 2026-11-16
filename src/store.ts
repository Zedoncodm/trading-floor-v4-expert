import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultSettings, DEFAULT_AGENT_PROMPTS } from "./llm.ts";
import { dayKey, isoWeek, ticketDay } from "./time.ts";
import { AGENT_IDS, type AgentId, type DeskState, type Ticket } from "./types.ts";

export class DeskStore {
  readonly dir: string;
  readonly statePath: string;
  readonly blotterPath: string;

  constructor(dataDir: string) {
    this.dir = dataDir;
    mkdirSync(this.dir, { recursive: true });
    this.statePath = join(this.dir, "state.json");
    this.blotterPath = join(this.dir, "blotter.jsonl");
  }

  loadOrCreate(
    startEquity: number,
    tz: string,
    symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
    scanIntervalMin = 15,
    now = Date.now(),
  ): DeskState {
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.statePath, "utf8")) as DeskState;
        return this.ensureDefaults(raw, startEquity, tz, symbols, scanIntervalMin, now);
      } catch {
        // Fallback to fresh seed if corrupted
      }
    }
    const fresh = this.createEmpty(startEquity, tz, symbols, scanIntervalMin, now);
    this.save(fresh);
    return fresh;
  }

  private createEmpty(
    startEquity: number,
    tz: string,
    symbols: string[],
    scanIntervalMin: number,
    now: number,
  ): DeskState {
    const activities = {} as DeskState["activities"];
    for (const id of AGENT_IDS) {
      activities[id] = {
        agent: id,
        status: id === "lead" ? "watch" : "idle",
        label: id === "lead" ? "Coordination & veille active" : "En salle — prêt",
        updatedAt: now,
      };
    }
    return {
      version: 1,
      startEquity,
      realizedPnl: 0,
      dayKey: dayKey(now, tz),
      dayStartEquity: startEquity,
      halted: false,
      haltKind: null,
      seqDay: ticketDay(now, tz),
      seq: 0,
      nonce: 0,
      tickets: [],
      killed: [],
      wakes: [],
      messages: [],
      curve: [
        {
          t: now - 3600_000 * 6,
          eq: startEquity,
          realized: 0,
          unrealized: 0,
          drawdownPct: 0,
        },
        {
          t: now,
          eq: startEquity,
          realized: 0,
          unrealized: 0,
          drawdownPct: 0,
        },
      ],
      tape: [],
      activities,
      pulses: [],
      cooldowns: {},
      reportWeek: isoWeek(now, tz),
      lastScanAt: 0,
      lastTickAt: now,
      onOvernight: false,
      overnightLog: [],
      tgOffset: 0,
      exchangeNote: "MODE PAPER · Aucune clé connectée · Toute clé avec permission de retrait est refusée d'office.",
      telegramConnected: false,
      settings: createDefaultSettings(symbols, scanIntervalMin),
      agentPrompts: JSON.parse(JSON.stringify(DEFAULT_AGENT_PROMPTS)),
      llmCallCount: 0,
      lastLlmProviderUsed: "Moteur déterministe FR (0 coût)",
      volatilityShieldUntil: 0,
      macroEvents: [],
      socialSentiment: {},
      fomoSignals: [],
    };
  }

  private ensureDefaults(
    s: DeskState,
    startEquity: number,
    tz: string,
    symbols: string[],
    scanIntervalMin: number,
    now: number,
  ): DeskState {
    const empty = this.createEmpty(startEquity, tz, symbols, scanIntervalMin, now);
    return {
      ...empty,
      ...s,
      activities: { ...empty.activities, ...(s.activities ?? {}) },
      messages: s.messages ?? [],
      curve: s.curve?.length ? s.curve : empty.curve,
      tape: s.tape ?? [],
      pulses: s.pulses ?? [],
      settings: { ...empty.settings, ...(s.settings ?? {}) },
      agentPrompts: { ...empty.agentPrompts, ...(s.agentPrompts ?? {}) },
    };
  }

  save(state: DeskState): void {
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, this.statePath);
  }

  appendBlotter(event: string, ticket: Ticket, note: string, at = Date.now()): void {
    const row = JSON.stringify({
      at,
      iso: new Date(at).toISOString(),
      event,
      ticketId: ticket.id,
      asset: ticket.asset,
      direction: ticket.direction,
      status: ticket.status,
      notional: ticket.notional,
      entry: ticket.entry,
      invalidation: ticket.invalidation,
      target: ticket.target,
      fillPrice: ticket.fillPrice ?? null,
      exitPrice: ticket.exitPrice ?? null,
      pnl: ticket.pnl ?? null,
      closeReason: ticket.closeReason ?? null,
      producedBy: ticket.producedBy,
      note,
    });
    appendFileSync(this.blotterPath, `${row}\n`, "utf8");
  }
}

export function setAgentActivity(
  state: DeskState,
  agent: AgentId,
  status: DeskState["activities"][AgentId]["status"],
  label: string,
  now = Date.now(),
  extra: { targetAgent?: AgentId; asset?: string } = {},
): void {
  state.activities[agent] = {
    agent,
    status,
    label,
    updatedAt: now,
    ...extra,
  };
}

export function emitPulse(
  state: DeskState,
  from: AgentId | "human",
  to: AgentId | "human",
  kind: DeskState["pulses"][number]["kind"],
  label: string,
  asset?: string,
  now = Date.now(),
): void {
  state.nonce += 1;
  state.pulses = [
    ...state.pulses.slice(-45),
    {
      id: `p${state.nonce}`,
      at: now,
      from,
      to,
      kind,
      label,
      ...(asset ? { asset } : {}),
    },
  ];
}
