import { AGENT_IDS, type AgentId } from "./types.ts";

/** Hard limits from the desk charter. Not configurable on purpose. */
export const MAX_RISK = 0.03;
export const MAX_EXPOSURE = 0.1;
export const MAX_DAY_LOSS = 0.05;

export type Config = {
  mode: "telegram" | "console";
  tradingMode: "paper";
  tokens: Record<AgentId, string>;
  chatId: string;
  humanUserId: number;
  humanUsername: string;
  timeZone: string;
  paperEquity: number;
  symbols: string[];
  scanIntervalMin: number;
  monitorIntervalSec: number;
  ticketTtlMin: number;
  overnightStart: number;
  overnightEnd: number;
  reportHour: number;
  dataDir: string;
  binanceKey: string;
  binanceSecret: string;
};

export class ConfigError extends Error {}

export const TOKEN_ENV: Record<AgentId, string> = {
  lead: "TG_TOKEN_LEAD",
  analyst: "TG_TOKEN_ANALYST",
  strategist: "TG_TOKEN_STRATEGIST",
  risk: "TG_TOKEN_RISK",
  execution: "TG_TOKEN_EXECUTION",
  reviewer: "TG_TOKEN_REVIEWER",
  sentinel: "TG_TOKEN_SENTINEL",
  hunter: "TG_TOKEN_HUNTER",
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${name} doit être un nombre entre ${min} et ${max} (reçu "${raw}").`);
  }
  return n;
}

export function loadConfig(argv: string[]): Config {
  const mode = argv.includes("--console") ? "console" : "telegram";

  const trading = (env("TRADING_MODE") || "paper").toLowerCase();
  if (trading !== "paper") {
    throw new ConfigError(
      `TRADING_MODE="${trading}" refusé. Ce desk tourne uniquement en mode paper : aucun connecteur d'exécution réel n'existe dans cette version.`,
    );
  }

  const tokens = {} as Record<AgentId, string>;
  const missing: string[] = [];
  for (const id of AGENT_IDS) {
    tokens[id] = env(TOKEN_ENV[id]);
    if (!tokens[id]) missing.push(TOKEN_ENV[id]);
  }
  const chatId = env("TG_CHAT_ID");
  const humanRaw = env("TG_HUMAN_USER_ID");

  if (mode === "telegram") {
    if (missing.length) throw new ConfigError(`Tokens manquants dans .env : ${missing.join(", ")}.`);
    if (new Set(Object.values(tokens)).size !== AGENT_IDS.length) {
      throw new ConfigError("Les 6 tokens doivent être différents : chaque agent est son propre bot.");
    }
    if (!/^-?\d+$/.test(chatId)) throw new ConfigError("TG_CHAT_ID manquant ou invalide. Lancez npm run chat-id.");
    if (!/^\d+$/.test(humanRaw)) throw new ConfigError("TG_HUMAN_USER_ID manquant ou invalide. Lancez npm run chat-id.");
  }

  const symbols = (env("SYMBOLS") || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  for (const s of symbols) {
    if (!/^[A-Z0-9]{2,20}USDT$/.test(s)) throw new ConfigError(`Symbole invalide : ${s} (format attendu : BTCUSDT).`);
  }

  const timeZone = env("TZ_NAME") || "Europe/Paris";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ConfigError(`Fuseau horaire inconnu : ${timeZone}.`);
  }

  return {
    mode,
    tradingMode: "paper",
    tokens,
    chatId: chatId || "console",
    humanUserId: humanRaw ? Number(humanRaw) : 0,
    humanUsername: env("TG_HUMAN_USERNAME").replace(/^@/, ""),
    timeZone,
    paperEquity: num("PAPER_EQUITY", 10_000, 100, 1e9),
    symbols,
    scanIntervalMin: num("SCAN_INTERVAL_MIN", 15, 1, 1440),
    monitorIntervalSec: num("MONITOR_INTERVAL_SEC", 30, 5, 600),
    ticketTtlMin: num("TICKET_TTL_MIN", 60, 5, 1440),
    overnightStart: num("OVERNIGHT_START", 22, 0, 23),
    overnightEnd: num("OVERNIGHT_END", 7, 0, 23),
    reportHour: num("REPORT_HOUR", 9, 0, 23),
    dataDir: env("DATA_DIR") || (mode === "console" ? "data/console" : "data"),
    binanceKey: env("BINANCE_API_KEY"),
    binanceSecret: env("BINANCE_API_SECRET"),
  };
}
