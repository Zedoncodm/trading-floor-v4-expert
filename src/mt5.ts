import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type LocalMt5Position = {
  ticket: number;
  id: string;
  symbol: string;
  side: "BUY" | "SELL";
  lots: number;
  entry: number;
  current: number;
  sl: number;
  tp: number;
  profit: number;
  magic: number;
};

export type LocalMt5Quote = {
  symbol: string;
  brokerSymbol?: string;
  bid: number;
  ask: number;
  tradeMode?: number;
};

export type LocalMt5State = {
  connected: boolean;
  timestamp: number;
  serverTimestamp?: number;
  login: number;
  server: string;
  currency: string;
  balance: number;
  equity: number;
  profit: number;
  freeMargin: number;
  leverage: number;
  tradeAllowed: boolean;
  positions: LocalMt5Position[];
  quotes: LocalMt5Quote[];
};

const US_EQUITY_SYMBOLS = new Set(["NVDA", "AAPL", "TSLA", "MSFT", "AMZN"]);

export function isUsRegularMarketHoursUtc(now = Date.now()): boolean {
  const d = new Date(now);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 14 * 60 + 30 && mins < 21 * 60;
}

export type Mt5Credentials = {
  enabled: boolean;
  metaApiToken: string;
  accountId: string;
  login: string;
  password: string;
  server: string;
  defaultLots: number;
};

const MT5_CLIENT_BASE = "https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai";
const MT5_PROVISIONING_BASE = "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";

export class Mt5CloudBridge {
  private readonly cfgPath: string;
  private creds: Mt5Credentials;

  constructor(dataDir = "data/console") {
    mkdirSync(dataDir, { recursive: true });
    this.cfgPath = join(dataDir, "mt5_config.json");
    this.creds = {
      enabled: false,
      metaApiToken: (process.env.METAAPI_TOKEN ?? "").trim(),
      accountId: (process.env.METAAPI_ACCOUNT_ID ?? "").trim(),
      login: (process.env.MT5_LOGIN ?? "").trim(),
      password: (process.env.MT5_PASSWORD ?? "").trim(),
      server: (process.env.MT5_SERVER ?? "").trim(),
      defaultLots: Number(process.env.MT5_DEFAULT_LOTS ?? 0.01) || 0.01,
    };
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.cfgPath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.cfgPath, "utf8")) as Partial<Mt5Credentials>;
      this.creds = {
        ...this.creds,
        ...saved,
        defaultLots: Math.max(0.01, Math.min(100, Number(saved.defaultLots ?? this.creds.defaultLots) || 0.01)),
      };
    } catch {
      // ignore corrupted config
    }
  }

  private saveToDisk(): void {
    const tmp = `${this.cfgPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.creds, null, 2), "utf8");
    renameSync(tmp, this.cfgPath);
  }

  configure(patch: Partial<Mt5Credentials>): Mt5Credentials {
    this.creds = {
      ...this.creds,
      ...patch,
      metaApiToken: patch.metaApiToken !== undefined ? patch.metaApiToken.trim() : this.creds.metaApiToken,
      accountId: patch.accountId !== undefined ? patch.accountId.trim() : this.creds.accountId,
      login: patch.login !== undefined ? patch.login.trim() : this.creds.login,
      password: patch.password !== undefined ? patch.password : this.creds.password,
      server: patch.server !== undefined ? patch.server.trim() : this.creds.server,
      defaultLots:
        patch.defaultLots !== undefined
          ? Math.max(0.01, Math.min(100, Number(patch.defaultLots) || 0.01))
          : this.creds.defaultLots,
    };
    this.saveToDisk();
    return this.creds;
  }

  getPublicSettings(): {
    mt5Enabled: boolean;
    metaApiAccountId: string;
    mt5Login: string;
    mt5Server: string;
    mt5DefaultLots: number;
    mt5TokenHint: string;
  } {
    const tok = this.creds.metaApiToken;
    return {
      mt5Enabled: this.creds.enabled,
      metaApiAccountId: this.creds.accountId,
      mt5Login: this.creds.login,
      mt5Server: this.creds.server,
      mt5DefaultLots: this.creds.defaultLots,
      mt5TokenHint: tok ? `${tok.slice(0, 6)}...${tok.slice(-4)}` : "",
    };
  }

  isConfigured(): boolean {
    return Boolean(this.creds.enabled && this.creds.metaApiToken && this.creds.accountId);
  }

  static mapSymbolToMt5(symbol: string): string {
    const raw = (symbol || "").trim().toUpperCase();
    const map: Record<string, string> = {
      BTCUSDT: "BTCUSD",
      ETHUSDT: "ETHUSD",
      SOLUSDT: "SOLUSD",
      BNBUSDT: "BNBUSD",
      XRPUSDT: "XRPUSD",
      AVAXUSDT: "AVAXUSD",
      DOGEUSDT: "DOGEUSD",
      LINKUSDT: "LINKUSD",
      "NQ1!": "USTEC",
      "ES1!": "US500",
      "YM1!": "US30",
      "FDAX1!": "DE40",
    };
    if (map[raw]) return map[raw];
    if (raw.endsWith("USDT")) return `${raw.slice(0, -4)}USD`;
    return raw;
  }

  async verifyOrProvisionAccount(): Promise<{
    ok: boolean;
    status: string;
    accountId?: string;
    balance?: number;
    equity?: number;
    broker?: string;
    currency?: string;
  }> {
    if (!this.creds.metaApiToken) {
      return { ok: false, status: "Token MetaApi manquant." };
    }
    const headers = {
      "auth-token": this.creds.metaApiToken,
      "content-type": "application/json",
    };

    try {
      // Auto-provision account if login + password + server supplied without accountId
      if (!this.creds.accountId && this.creds.login && this.creds.password && this.creds.server) {
        const listRes = await fetch(`${MT5_PROVISIONING_BASE}/users/current/accounts`, {
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (listRes.ok) {
          const list = (await listRes.json()) as Array<{ _id?: string; id?: string; login?: string; server?: string }>;
          const match = list.find(
            (a) => String(a.login) === this.creds.login && String(a.server).toLowerCase() === this.creds.server.toLowerCase(),
          );
          if (match && (match._id || match.id)) {
            this.creds.accountId = String(match._id ?? match.id);
          }
        }
        if (!this.creds.accountId) {
          const createRes = await fetch(`${MT5_PROVISIONING_BASE}/users/current/accounts`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              name: `TradingFloor-${this.creds.login}`,
              type: "cloud",
              login: this.creds.login,
              password: this.creds.password,
              server: this.creds.server,
              platform: "mt5",
              magic: 4080,
            }),
            signal: AbortSignal.timeout(12_000),
          });
          const created = (await createRes.json()) as { id?: string; message?: string };
          if (!createRes.ok || !created.id) {
            return { ok: false, status: `Provisioning MT5 refusé : ${created.message ?? createRes.statusText}` };
          }
          this.creds.accountId = created.id;
          await fetch(`${MT5_PROVISIONING_BASE}/users/current/accounts/${this.creds.accountId}/deploy`, {
            method: "POST",
            headers,
            signal: AbortSignal.timeout(10_000),
          });
        }
        this.saveToDisk();
      }

      if (!this.creds.accountId) {
        return {
          ok: false,
          status: "Renseignez soit l'Account ID MetaApi, soit Login + Mot de passe + Serveur MT5.",
        };
      }

      const infoRes = await fetch(
        `${MT5_CLIENT_BASE}/users/current/accounts/${encodeURIComponent(this.creds.accountId)}/account-information`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      const info = (await infoRes.json()) as {
        balance?: number;
        equity?: number;
        broker?: string;
        currency?: string;
        message?: string;
      };
      if (!infoRes.ok) {
        return {
          ok: false,
          accountId: this.creds.accountId,
          status: `Compte MT5 en cours de déploiement ou erreur : ${info.message ?? infoRes.statusText}`,
        };
      }
      this.creds.enabled = true;
      this.saveToDisk();
      return {
        ok: true,
        accountId: this.creds.accountId,
        balance: info.balance,
        equity: info.equity,
        broker: info.broker,
        currency: info.currency,
        status: `Connecté MT5 Cloud (${info.broker ?? this.creds.server} · Solde ${info.balance ?? "--"} ${info.currency ?? "USD"})`,
      };
    } catch (e) {
      return { ok: false, status: `Erreur réseau MetaApi : ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async openMarketOrder(params: {
    symbol: string;
    direction: "long" | "short";
    lots?: number;
    stopLoss?: number;
    takeProfit?: number;
    comment?: string;
  }): Promise<{ ok: boolean; positionId?: string; message: string }> {
    if (!this.isConfigured()) {
      return { ok: false, message: "Pont MT5 désactivé ou non configuré." };
    }
    const mt5Sym = Mt5CloudBridge.mapSymbolToMt5(params.symbol);
    const volume = Number(Math.max(0.01, Math.min(50, params.lots ?? this.creds.defaultLots)).toFixed(2));
    try {
      const res = await fetch(
        `${MT5_CLIENT_BASE}/users/current/accounts/${encodeURIComponent(this.creds.accountId)}/trade`,
        {
          method: "POST",
          headers: {
            "auth-token": this.creds.metaApiToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            actionType: params.direction === "long" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
            symbol: mt5Sym,
            volume,
            ...(params.stopLoss ? { stopLoss: Number(params.stopLoss.toFixed(5)) } : {}),
            ...(params.takeProfit ? { takeProfit: Number(params.takeProfit.toFixed(5)) } : {}),
            comment: (params.comment ?? "TradingFloorV3").slice(0, 28),
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const data = (await res.json()) as { stringCode?: string; positionId?: string; orderId?: string; message?: string };
      if (!res.ok || (data.stringCode && data.stringCode !== "TRADE_RETCODE_DONE")) {
        return { ok: false, message: `Refus MT5 (${mt5Sym}) : ${data.message ?? data.stringCode ?? res.statusText}` };
      }
      const positionId = String(data.positionId ?? data.orderId ?? "");
      return { ok: true, positionId, message: `Exécuté MT5 Mobile : ${mt5Sym} ${volume} lot(s) (#${positionId})` };
    } catch (e) {
      return { ok: false, message: `Erreur ordre MT5 : ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async closePosition(positionId: string): Promise<{ ok: boolean; message: string }> {
    if (!this.isConfigured() || !positionId) {
      return { ok: false, message: "Aucune position MT5 à clôturer." };
    }
    try {
      const res = await fetch(
        `${MT5_CLIENT_BASE}/users/current/accounts/${encodeURIComponent(this.creds.accountId)}/trade`,
        {
          method: "POST",
          headers: {
            "auth-token": this.creds.metaApiToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            actionType: "POSITION_CLOSE_ID",
            positionId,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      const data = (await res.json()) as { stringCode?: string; message?: string };
      if (!res.ok || (data.stringCode && data.stringCode !== "TRADE_RETCODE_DONE")) {
        return { ok: false, message: `Clôture MT5 échouée : ${data.message ?? data.stringCode ?? res.statusText}` };
      }
      return { ok: true, message: `Position MT5 #${positionId} clôturée.` };
    } catch (e) {
      return { ok: false, message: `Erreur clôture MT5 : ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  static mapMt5SymbolToDesk(symbol: string): string {
    const raw = (symbol || "").trim().toUpperCase();
    const stripped = raw.replace(/(?:\.R|\.PRO|\.A|\.C|MICRO|RAW|_I|[M+])$/i, "");
    const rev: Record<string, string> = {
      BTCUSD: "BTCUSDT",
      BITCOIN: "BTCUSDT",
      ETHUSD: "ETHUSDT",
      SOLUSD: "SOLUSDT",
      BNBUSD: "BNBUSDT",
      XRPUSD: "XRPUSDT",
      AVAXUSD: "AVAXUSDT",
      DOGEUSD: "DOGEUSDT",
      LINKUSD: "LINKUSDT",
      USTEC: "NQ1!",
      NAS100: "NQ1!",
      US500: "ES1!",
      SPX500: "ES1!",
      US30: "YM1!",
      DE40: "FDAX1!",
      GER40: "FDAX1!",
      GOLD: "XAUUSD",
      WTI: "USOIL",
    };
    return rev[raw] ?? rev[stripped] ?? stripped ?? raw;
  }

  static getMt5FilesDirectories(): string[] {
    const dirs: string[] = [];
    const appData = process.env.APPDATA;
    if (!appData) return dirs;
    const baseDir = join(appData, "MetaQuotes", "Terminal");
    if (!existsSync(baseDir)) return dirs;
    try {
      const entries = readdirSync(baseDir, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && ent.name.length >= 20) {
          const targetDir = join(baseDir, ent.name, "MQL5", "Files");
          if (existsSync(targetDir)) {
            dirs.push(targetDir);
          }
        }
      }
    } catch {
      // ignore fs error
    }
    return dirs;
  }

  static readLocalMt5State(maxAgeMs = 25_000): LocalMt5State | null {
    const dirs = Mt5CloudBridge.getMt5FilesDirectories();
    for (const dir of dirs) {
      const statePath = join(dir, "mt5_state.json");
      if (!existsSync(statePath)) continue;
      try {
        const st = statSync(statePath);
        if (Date.now() - st.mtimeMs > maxAgeMs) continue;
        const raw = readFileSync(statePath, "utf8").replace(/^\uFEFF/, "").trim();
        if (!raw) continue;
        const parsed = JSON.parse(raw) as LocalMt5State;
        if (parsed && parsed.connected) {
          return parsed;
        }
      } catch {
        // ignore transient read/parse conflict
      }
    }
    return null;
  }

  static writeLocalBridgePayload(payload: unknown): void {
    const dirs = Mt5CloudBridge.getMt5FilesDirectories();
    if (!dirs.length) return;
    const json = JSON.stringify(payload);
    for (const dir of dirs) {
      try {
        writeFileSync(join(dir, "trading_floor_bridge.json"), json, "utf8");
      } catch {
        // ignore sharing contention
      }
    }
  }

  static computeAssetLots(asset: string, notional: number, entryPrice: number, qty?: number): number {
    if (!notional || notional <= 0 || !entryPrice || entryPrice <= 0) return 0.01;
    const sym = (asset || "").trim().toUpperCase();
    const effectiveQty = qty && qty > 0 ? qty : notional / entryPrice;

    // 1. Paires Forex (EURUSD, GBPUSD, USDJPY, AUDUSD, NZDUSD, USDCAD, USDCHF, EURGBP, etc.)
    // Taille standard MT5 = 100 000 unités de la devise de base.
    if (/^(EUR|GBP|USD|AUD|NZD|CAD|CHF|JPY){2}/.test(sym)) {
      const baseUnits = sym.startsWith("USD") ? notional : notional / entryPrice;
      const lots = baseUnits / 100_000;
      return Number(Math.max(0.01, Math.min(100, Math.round(lots * 100) / 100)).toFixed(2));
    }

    // 2. Or (XAUUSD, GOLD) -> 1 lot standard = 100 onces troy
    if (sym === "XAUUSD" || sym === "GOLD") {
      const ounces = effectiveQty;
      const lots = ounces / 100;
      return Number(Math.max(0.01, Math.min(100, Math.round(lots * 100) / 100)).toFixed(2));
    }

    // 3. Argent (XAGUSD, SILVER) -> 1 lot standard = 5 000 onces troy
    if (sym === "XAGUSD" || sym === "SILVER") {
      const ounces = effectiveQty;
      const lots = ounces / 5000;
      return Number(Math.max(0.01, Math.min(100, Math.round(lots * 100) / 100)).toFixed(2));
    }

    // 4. Pétrole brut (USOIL, WTI) -> 1 lot CFD = 100 barils
    if (sym === "USOIL" || sym === "WTI") {
      const barrels = effectiveQty;
      const lots = barrels / 100;
      return Number(Math.max(0.01, Math.min(100, Math.round(lots * 100) / 100)).toFixed(2));
    }

    // 5. Crypto (BTCUSDT, ETHUSDT, SOLUSDT, etc.) -> 1 lot = 1 coin / contrat
    if (/USDT$|USD$/.test(sym) && (sym.startsWith("BTC") || sym.startsWith("ETH") || sym.startsWith("SOL") || sym.startsWith("BNB") || sym.startsWith("XRP") || sym.startsWith("DOGE") || sym.startsWith("AVAX") || sym.startsWith("LINK"))) {
      const coins = effectiveQty;
      return Number(Math.max(0.01, Math.min(100, Math.round(coins * 100) / 100)).toFixed(2));
    }

    // 6. Indices (NQ1!, ES1!, YM1!, FDAX1!, NAS100, US30, US500, GER40)
    if (/NQ|ES|YM|FDAX|NAS|SPX|US30|US500|GER40|DE40/i.test(sym)) {
      const contracts = effectiveQty;
      return Number(Math.max(0.01, Math.min(100, Math.round(contracts * 100) / 100)).toFixed(2));
    }

    // 7. Actions US (TSLA, MSFT, AAPL, NVDA, AMZN) -> 1 lot = 1 action
    const shares = effectiveQty;
    return Number(Math.max(0.01, Math.min(500, Math.round(shares * 100) / 100)).toFixed(2));
  }

  static buildLocalBridgePayload(
    tickets: Array<{
      id: string;
      asset: string;
      direction: "long" | "short";
      status: string;
      entry?: number;
      fillPrice?: number;
      invalidation: number;
      target: number;
      mt5Lots?: number;
      notional?: number;
      qty?: number;
      leverage?: number;
      closedAt?: number;
      mt5PositionId?: string;
    }>,
    defaultLots = 0.01,
    now = Date.now(),
  ): {
    ok: boolean;
    timestamp: number;
    openOrders: Array<{
      id: string;
      symbol: string;
      side: "BUY" | "SELL";
      lots: number;
      entry: number;
      sl: number;
      tp: number;
    }>;
    closeOrders: Array<{
      ticket: number;
      id: string;
    }>;
  } {
    const usOpen = isUsRegularMarketHoursUtc(now);
    const openOrders = tickets
      .filter((t) => {
        if (t.status !== "open") return false;
        const symUpper = (t.asset || "").trim().toUpperCase();
        if (!usOpen && US_EQUITY_SYMBOLS.has(symUpper)) return false;
        return true;
      })
      .map((t) => {
        const rawLots = (t.mt5Lots && t.mt5Lots > 0)
          ? t.mt5Lots
          : (t.notional && t.notional > 0)
            ? Mt5CloudBridge.computeAssetLots(t.asset, t.notional, (t.fillPrice ?? t.entry) || 1, t.qty)
            : defaultLots ?? 0.01;
        const lots = Number(Math.max(0.01, Math.min(100, rawLots)).toFixed(2));
        return {
          id: t.id,
          symbol: Mt5CloudBridge.mapSymbolToMt5(t.asset),
          side: (t.direction === "long" ? "BUY" : "SELL") as "BUY" | "SELL",
          lots,
          entry: Number(((t.fillPrice ?? t.entry) || 0).toFixed(5)),
          sl: Number(t.invalidation.toFixed(5)),
          tp: Number(t.target.toFixed(5)),
        };
      });

    const closeOrders = tickets
      .filter((t) => t.status === "closed" && t.mt5PositionId && (now - (t.closedAt ?? now)) < 120_000)
      .map((t) => ({
        ticket: Number(t.mt5PositionId),
        id: t.id,
      }));

    return {
      ok: true,
      timestamp: now,
      openOrders,
      closeOrders,
    };
  }

  static generateMql5ExpertAdvisor(baseUrl = "http://127.0.0.1:4080"): string {
    return `//+------------------------------------------------------------------+
//|                                           TradingFloorBridge.mq5 |
//|     Passerelle Bidirectionnelle v2.0 Trading Floor <-> MT5       |
//+------------------------------------------------------------------+
#property copyright "Trading Floor V3"
#property version   "2.00"
#include <Trade\\Trade.mqh>

input string InpServerUrl   = "${baseUrl}";
input string InpBridgeFile  = "trading_floor_bridge.json";
input string InpStateFile   = "mt5_state.json";
input int    InpPollSeconds = 1;
input long   InpMagic       = 4080;

CTrade trade;
double gMyMasterId = 0.0;
string gFailedIds  = "|";
datetime gLastFailReset = 0;

string JsonEscape(const string s) {
   string out = s;
   StringReplace(out, "\\\\", "\\\\\\\\");
   StringReplace(out, "\\"", "\\\\\\"");
   StringReplace(out, "\\r", " ");
   StringReplace(out, "\\n", " ");
   return out;
}

bool EnsureMaster() {
   long nowLocal = (long)TimeLocal();
   if(!GlobalVariableCheck("TF_MASTER_CHART") || !GlobalVariableCheck("TF_MASTER_TS") ||
      (nowLocal - (long)GlobalVariableGet("TF_MASTER_TS") > 3)) {
      GlobalVariableSet("TF_MASTER_CHART", gMyMasterId);
      GlobalVariableSet("TF_MASTER_TS", (double)nowLocal);
      return true;
   }
   if(GlobalVariableGet("TF_MASTER_CHART") == gMyMasterId) {
      GlobalVariableSet("TF_MASTER_TS", (double)nowLocal);
      return true;
   }
   return false;
}

string ExtractStr(const string src, const string key, int startPos) {
   int p = StringFind(src, "\\"" + key + "\\":\\"", startPos);
   if(p < 0) return "";
   p += StringLen(key) + 4;
   int e = StringFind(src, "\\"", p);
   if(e < 0) return "";
   return StringSubstr(src, p, e - p);
}

double ExtractNum(const string src, const string key, int startPos) {
   int p = StringFind(src, "\\"" + key + "\\":", startPos);
   if(p < 0) return 0.0;
   p += StringLen(key) + 3;
   int eComma = StringFind(src, ",", p);
   int eBrace = StringFind(src, "}", p);
   int e = (eComma >= 0 && (eBrace < 0 || eComma < eBrace)) ? eComma : eBrace;
   if(e < 0) return 0.0;
   return StringToDouble(StringSubstr(src, p, e - p));
}

string TryAliasMatch(const string cand) {
   if(cand == "") return "";
   if(SymbolSelect(cand, true)) {
      if(SymbolInfoDouble(cand, SYMBOL_BID) > 0.0) return cand;
   }
   string sfx[] = { "m", ".r", ".pro", "raw", "+", "_i", "micro", ".a", ".c", "#" };
   for(int i = 0; i < ArraySize(sfx); i++) {
      string test = cand + sfx[i];
      if(SymbolSelect(test, true) && SymbolInfoDouble(test, SYMBOL_BID) > 0.0) return test;
   }
   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++) {
      string name = SymbolName(i, false);
      if(StringFind(name, cand) == 0 && SymbolSelect(name, true)) {
         if(SymbolInfoDouble(name, SYMBOL_BID) > 0.0) return name;
      }
   }
   return "";
}

string ResolveBrokerSymbol(const string baseSym) {
   string sym = baseSym;
   StringToUpper(sym);
   string direct = TryAliasMatch(sym);
   if(direct != "") return direct;
   if(sym == "BTCUSDT" || sym == "BTCUSD" || sym == "BTC") {
      string b1 = TryAliasMatch("BTCUSD"); if(b1 != "") return b1;
      string b2 = TryAliasMatch("BTCUSDT"); if(b2 != "") return b2;
      return TryAliasMatch("Bitcoin");
   }
   if(sym == "ETHUSDT" || sym == "ETHUSD" || sym == "ETH") {
      string e1 = TryAliasMatch("ETHUSD"); if(e1 != "") return e1;
      return TryAliasMatch("ETHUSDT");
   }
   if(sym == "SOLUSDT" || sym == "SOLUSD") {
      string s1 = TryAliasMatch("SOLUSD"); if(s1 != "") return s1;
      return TryAliasMatch("SOLUSDT");
   }
   if(sym == "USTEC" || sym == "NQ1!") {
      string a1 = TryAliasMatch("USTEC"); if(a1 != "") return a1;
      string a2 = TryAliasMatch("NAS100"); if(a2 != "") return a2;
      return TryAliasMatch("NDX");
   }
   if(sym == "US30" || sym == "YM1!") {
      string d1 = TryAliasMatch("US30"); if(d1 != "") return d1;
      string d2 = TryAliasMatch("DJ30"); if(d2 != "") return d2;
      return TryAliasMatch("WS30");
   }
   if(sym == "US500" || sym == "ES1!") {
      string sp1 = TryAliasMatch("US500"); if(sp1 != "") return sp1;
      return TryAliasMatch("SPX500");
   }
   if(sym == "DE40" || sym == "FDAX1!") {
      string de1 = TryAliasMatch("DE40"); if(de1 != "") return de1;
      return TryAliasMatch("GER40");
   }
   if(sym == "USOIL") {
      string o1 = TryAliasMatch("USOIL"); if(o1 != "") return o1;
      return TryAliasMatch("WTI");
   }
   if(sym == "XAUUSD") {
      string x1 = TryAliasMatch("XAUUSD"); if(x1 != "") return x1;
      return TryAliasMatch("GOLD");
   }
   return "";
}

double NormalizeLots(const string sym, const double rawLots) {
   double vmin  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(vmin <= 0.0)  vmin = 0.01;
   if(vmax <= 0.0)  vmax = 50.0;
   if(vstep <= 0.0) vstep = 0.01;
   double clamped = MathMax(vmin, MathMin(vmax, rawLots));
   double stepped = MathFloor(clamped / vstep + 1e-6) * vstep;
   return NormalizeDouble(MathMax(vmin, stepped), 2);
}

bool HasOpenPositionForId(const string id) {
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string cmt = PositionGetString(POSITION_COMMENT);
      if(cmt == id && PositionGetInteger(POSITION_MAGIC) == InpMagic) return true;
      if(StringFind(id, "MT5-") == 0) {
         string subTicket = StringSubstr(id, 4);
         if(IntegerToString((long)ticket) == subTicket) return true;
      }
   }
   return false;
}

bool ModifyPositionByComment(const string id, const string realSym, double slPx, double tpPx) {
   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagic && PositionGetString(POSITION_COMMENT) == id) {
         return trade.PositionModify(ticket, slPx, tpPx);
      }
   }
   return trade.PositionModify(realSym, slPx, tpPx);
}

void WriteMt5StateToFile() {
   long login    = AccountInfoInteger(ACCOUNT_LOGIN);
   string server = AccountInfoString(ACCOUNT_SERVER);
   string curr   = AccountInfoString(ACCOUNT_CURRENCY);
   double bal    = AccountInfoDouble(ACCOUNT_BALANCE);
   double eq     = AccountInfoDouble(ACCOUNT_EQUITY);
   double prof   = AccountInfoDouble(ACCOUNT_PROFIT);
   double freeM  = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   long lev      = AccountInfoInteger(ACCOUNT_LEVERAGE);
   bool allowed  = (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0 && MQLInfoInteger(MQL_TRADE_ALLOWED) != 0);

   string json = "{";
   json += "\\"connected\\":true,";
   json += "\\"timestamp\\":" + IntegerToString((long)TimeGMT() * 1000) + ",";
   json += "\\"serverTimestamp\\":" + IntegerToString((long)TimeCurrent() * 1000) + ",";
   json += "\\"login\\":" + IntegerToString(login) + ",";
   json += "\\"server\\":\\"" + JsonEscape(server) + "\\",";
   json += "\\"currency\\":\\"" + JsonEscape(curr) + "\\",";
   json += "\\"balance\\":" + DoubleToString(bal, 2) + ",";
   json += "\\"equity\\":" + DoubleToString(eq, 2) + ",";
   json += "\\"profit\\":" + DoubleToString(prof, 2) + ",";
   json += "\\"freeMargin\\":" + DoubleToString(freeM, 2) + ",";
   json += "\\"leverage\\":" + IntegerToString(lev) + ",";
   json += "\\"tradeAllowed\\":" + (allowed ? "true" : "false") + ",";

   json += "\\"positions\\":[";
   int posCount = PositionsTotal();
   bool firstPos = true;
   for(int i = 0; i < posCount; i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string pSym   = PositionGetString(POSITION_SYMBOL);
      string pId    = PositionGetString(POSITION_COMMENT);
      long pType    = PositionGetInteger(POSITION_TYPE);
      string pSide  = (pType == POSITION_TYPE_BUY) ? "BUY" : "SELL";
      double pLots  = PositionGetDouble(POSITION_VOLUME);
      double pEntry = PositionGetDouble(POSITION_PRICE_OPEN);
      double pCurr  = PositionGetDouble(POSITION_PRICE_CURRENT);
      double pSl    = PositionGetDouble(POSITION_SL);
      double pTp    = PositionGetDouble(POSITION_TP);
      double pProf  = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      long pMagic   = PositionGetInteger(POSITION_MAGIC);
      int digits    = (int)SymbolInfoInteger(pSym, SYMBOL_DIGITS);
      if(digits < 2 || digits > 8) digits = 5;

      if(!firstPos) json += ",";
      firstPos = false;
      json += "{";
      json += "\\"ticket\\":" + IntegerToString((long)ticket) + ",";
      json += "\\"id\\":\\"" + JsonEscape(pId) + "\\",";
      json += "\\"symbol\\":\\"" + JsonEscape(pSym) + "\\",";
      json += "\\"side\\":\\"" + pSide + "\\",";
      json += "\\"lots\\":" + DoubleToString(pLots, 2) + ",";
      json += "\\"entry\\":" + DoubleToString(pEntry, digits) + ",";
      json += "\\"current\\":" + DoubleToString(pCurr, digits) + ",";
      json += "\\"sl\\":" + DoubleToString(pSl, digits) + ",";
      json += "\\"tp\\":" + DoubleToString(pTp, digits) + ",";
      json += "\\"profit\\":" + DoubleToString(pProf, 2) + ",";
      json += "\\"magic\\":" + IntegerToString(pMagic);
      json += "}";
   }
   json += "],";

   string quoteSyms[] = { "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "XAUUSD", "BTCUSD" };
   json += "\\"quotes\\":[";
   bool firstQ = true;
   for(int q = 0; q < ArraySize(quoteSyms); q++) {
      string qSym = quoteSyms[q];
      string realQ = ResolveBrokerSymbol(qSym);
      if(realQ == "") continue;
      double bid = SymbolInfoDouble(realQ, SYMBOL_BID);
      double ask = SymbolInfoDouble(realQ, SYMBOL_ASK);
      if(bid <= 0.0) continue;
      long tMode = SymbolInfoInteger(realQ, SYMBOL_TRADE_MODE);
      int qDigits = (int)SymbolInfoInteger(realQ, SYMBOL_DIGITS);
      if(qDigits < 2 || qDigits > 8) qDigits = 5;

      if(!firstQ) json += ",";
      firstQ = false;
      json += "{";
      json += "\\"symbol\\":\\"" + qSym + "\\",";
      json += "\\"brokerSymbol\\":\\"" + JsonEscape(realQ) + "\\",";
      json += "\\"bid\\":" + DoubleToString(bid, qDigits) + ",";
      json += "\\"ask\\":" + DoubleToString(ask, qDigits) + ",";
      json += "\\"tradeMode\\":" + IntegerToString(tMode);
      json += "}";
   }
   json += "]";
   json += "}";

   int handle = FileOpen(InpStateFile, FILE_WRITE | FILE_TXT | FILE_SHARE_READ | FILE_ANSI);
   if(handle != INVALID_HANDLE) {
      FileWriteString(handle, json);
      FileClose(handle);
   }
}

int OnInit() {
   long lowId = ChartID() & 0x7FFFFFFF;
   if(lowId == 0) lowId = (long)GetTickCount();
   gMyMasterId = (double)lowId;
   gLastFailReset = TimeLocal();

   trade.SetExpertMagicNumber(InpMagic);
   EventSetTimer(MathMax(1, InpPollSeconds));
   OnTimer();
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason) {
   EventKillTimer();
   if(GlobalVariableCheck("TF_MASTER_CHART") && GlobalVariableGet("TF_MASTER_CHART") == gMyMasterId) {
      GlobalVariableDel("TF_MASTER_CHART");
      GlobalVariableDel("TF_MASTER_TS");
   }
}

string ReadBodyFromBridge() {
   int handle = FileOpen(InpBridgeFile, FILE_READ | FILE_TXT | FILE_SHARE_READ | FILE_ANSI);
   if(handle != INVALID_HANDLE) {
      string content = "";
      while(!FileIsEnding(handle)) {
         content += FileReadString(handle);
      }
      FileClose(handle);
      if(StringLen(content) > 5) return content;
   }

   char post[];
   char result[];
   string headers;
   string url = InpServerUrl + "/api/mt5-bridge/poll";
   int res = WebRequest("GET", url, "", NULL, 2000, post, 0, result, headers);
   if(res == 200) {
      return CharArrayToString(result, 0, -1, CP_UTF8);
   }
   return "";
}

void OnTimer() {
   if(!EnsureMaster()) return;

   if(TimeLocal() - gLastFailReset >= 60) {
      gFailedIds = "|";
      gLastFailReset = TimeLocal();
   }

   WriteMt5StateToFile();

   bool tradeAllowed = (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0 && MQLInfoInteger(MQL_TRADE_ALLOWED) != 0);
   if(!tradeAllowed) return;

   string body = ReadBodyFromBridge();
   if(StringFind(body, "\\"openOrders\\":[") < 0) return;

   string activeIds = "|";
   int cursor = 0;
   bool stateDirty = false;

   while(true) {
      int idPos = StringFind(body, "\\"id\\":\\"", cursor);
      if(idPos < 0) break;

      string id     = ExtractStr(body, "id", idPos);
      string symRaw = ExtractStr(body, "symbol", idPos);
      string side   = ExtractStr(body, "side", idPos);
      double lots   = ExtractNum(body, "lots", idPos);
      double entry  = ExtractNum(body, "entry", idPos);
      double sl     = ExtractNum(body, "sl", idPos);
      double tp     = ExtractNum(body, "tp", idPos);

      int objEnd = StringFind(body, "}", idPos);
      cursor = (objEnd > idPos) ? objEnd : (idPos + StringLen(id) + 15);
      if(id == "" || symRaw == "") continue;
      activeIds += id + "|";

      if(HasOpenPositionForId(id)) continue;
      if(StringFind(id, "MT5-") == 0) continue;
      if(StringFind(gFailedIds, "|" + id + "|") >= 0) continue;

      string realSym = ResolveBrokerSymbol(symRaw);
      if(realSym == "" || SymbolInfoInteger(realSym, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED) {
         gFailedIds += id + "|";
         continue;
      }

      trade.SetTypeFillingBySymbol(realSym);
      double normLots = NormalizeLots(realSym, lots > 0.0 ? lots : 0.01);
      double ask = SymbolInfoDouble(realSym, SYMBOL_ASK);
      double bid = SymbolInfoDouble(realSym, SYMBOL_BID);
      int digits = (int)SymbolInfoInteger(realSym, SYMBOL_DIGITS);
      double point = SymbolInfoDouble(realSym, SYMBOL_POINT);
      double stopLevelPts = (double)SymbolInfoInteger(realSym, SYMBOL_TRADE_STOPS_LEVEL);
      double minDist = (stopLevelPts + 10.0) * point;

      double slDistRel = (entry > 0.0 && sl > 0.0) ? MathAbs(entry - sl) / entry : 0.0;
      double tpDistRel = (entry > 0.0 && tp > 0.0) ? MathAbs(tp - entry) / entry : 0.0;

      if(side == "BUY" && ask > 0.0) {
         double slPx = (slDistRel > 0.0) ? NormalizeDouble(ask - MathMax(minDist, ask * slDistRel), digits) : 0.0;
         double tpPx = (tpDistRel > 0.0) ? NormalizeDouble(ask + MathMax(minDist, ask * tpDistRel), digits) : 0.0;
         if(trade.Buy(normLots, realSym, ask, slPx, tpPx, id)) {
            stateDirty = true;
         } else {
            uint ret = trade.ResultRetcode();
            if(ret == TRADE_RETCODE_INVALID_STOPS || ret == 10016) {
               if(trade.Buy(normLots, realSym, ask, 0.0, 0.0, id)) {
                  ModifyPositionByComment(id, realSym, slPx, tpPx);
                  stateDirty = true;
               } else {
                  gFailedIds += id + "|";
               }
            } else if(ret != TRADE_RETCODE_CLIENT_DISABLES_AT && ret != TRADE_RETCODE_SERVER_DISABLES_AT && ret != TRADE_RETCODE_CONNECTION) {
               gFailedIds += id + "|";
            }
         }
      } else if(side == "SELL" && bid > 0.0) {
         double slPx = (slDistRel > 0.0) ? NormalizeDouble(bid + MathMax(minDist, bid * slDistRel), digits) : 0.0;
         double tpPx = (tpDistRel > 0.0) ? NormalizeDouble(bid - MathMax(minDist, bid * tpDistRel), digits) : 0.0;
         if(trade.Sell(normLots, realSym, bid, slPx, tpPx, id)) {
            stateDirty = true;
         } else {
            uint ret = trade.ResultRetcode();
            if(ret == TRADE_RETCODE_INVALID_STOPS || ret == 10016) {
               if(trade.Sell(normLots, realSym, bid, 0.0, 0.0, id)) {
                  ModifyPositionByComment(id, realSym, slPx, tpPx);
                  stateDirty = true;
               } else {
                  gFailedIds += id + "|";
               }
            } else if(ret != TRADE_RETCODE_CLIENT_DISABLES_AT && ret != TRADE_RETCODE_SERVER_DISABLES_AT && ret != TRADE_RETCODE_CONNECTION) {
               gFailedIds += id + "|";
            }
         }
      }
   }

   // Extraction des tickets à clôturer explicitement (closeOrders)
   string closeIds = "|";
   int closeCursor = StringFind(body, "\\"closeOrders\\":[");
   if(closeCursor >= 0) {
      while(true) {
         int tPos = StringFind(body, "\\"ticket\\":", closeCursor);
         if(tPos < 0) break;
         double ticketNum = ExtractNum(body, "ticket", tPos);
         if(ticketNum > 0.0) {
            closeIds += IntegerToString((long)ticketNum) + "|";
         }
         int oEnd = StringFind(body, "}", tPos);
         closeCursor = (oEnd > tPos) ? oEnd : (tPos + 20);
      }
   }

   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0) {
         string ticketStr = IntegerToString((long)ticket);
         string cmt = PositionGetString(POSITION_COMMENT);
         long pMagic = PositionGetInteger(POSITION_MAGIC);
         bool shouldClose = false;
         if(StringFind(closeIds, "|" + ticketStr + "|") >= 0) shouldClose = true;
         if(pMagic == InpMagic && StringLen(cmt) > 0 && StringFind(activeIds, "|" + cmt + "|") < 0) shouldClose = true;
         if(shouldClose) {
            if(trade.PositionClose(ticket)) {
               stateDirty = true;
            }
         }
      }
   }

   if(stateDirty) {
      WriteMt5StateToFile();
   }
}
`;
  }
}
