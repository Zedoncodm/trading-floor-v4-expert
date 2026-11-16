import type { AgentId } from "./types.ts";

export type Speaker = AgentId | "human";
export type MessageTone = "plain" | "wake" | "ticket" | "kill" | "report" | "fill" | "veto";

export type ChatMessage = {
  id: string;
  at: number;
  speaker: Speaker;
  text: string;
  tone: MessageTone;
  ticketId?: string;
  source?: "telegram" | "web" | "desk";
};

export type EquityPoint = {
  t: number;
  eq: number;
  realized: number;
  unrealized: number;
  drawdownPct: number;
};

export type AgentActivity = {
  agent: AgentId;
  status: "idle" | "scanning" | "verifying" | "backtesting" | "sizing" | "veto" | "killed" | "awaiting_human" | "executing" | "logging" | "watch";
  label: string;
  updatedAt: number;
  targetAgent?: AgentId;
  asset?: string;
};

export type SignalPulse = {
  id: string;
  at: number;
  from: AgentId | "human";
  to: AgentId | "human";
  kind: "flag" | "confirm" | "backtest_pass" | "backtest_kill" | "sized" | "veto" | "ticket" | "approve" | "reject" | "fill" | "log" | "wake";
  label: string;
  asset?: string;
};
