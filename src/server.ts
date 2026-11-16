import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { TradingFloorDesk } from "./desk.ts";
import { Mt5CloudBridge } from "./mt5.ts";
import type { AgentId, AgentPromptConfig, DeskRuntimeSettings } from "./types.ts";
import { DASHBOARD_HTML } from "./ui.ts";

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}") as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function startDashboardServer(desk: TradingFloorDesk, port = 4080): { url: string; close: () => void } {
  const clients = new Set<ServerResponse>();

  const unsub = desk.subscribe((state) => {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch {
        clients.delete(res);
      }
    }
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(DASHBOARD_HTML);
      return;
    }

    // Polices auto-hébergées (whitelist stricte : aucun chemin libre fourni par le client).
    if (req.method === "GET" && url.pathname.startsWith("/assets/fonts/")) {
      const allowed = new Set(["inter-latin-wght-normal.woff2", "inter-latin-ext-wght-normal.woff2"]);
      const name = url.pathname.slice("/assets/fonts/".length);
      if (allowed.has(name)) {
        try {
          const buf = await readFile(new URL(`../assets/fonts/${name}`, import.meta.url));
          res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" });
          res.end(buf);
          return;
        } catch {
          /* tombe sur le 404 ci-dessous */
        }
      }
      res.writeHead(404);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(desk.state));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(desk.state)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/command") {
      try {
        const parsed = await readJsonBody<{ text?: string }>(req);
        if (parsed.text) {
          await desk.handleHumanInput(parsed.text, "web");
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/settings") {
      try {
        const parsed = await readJsonBody<{
          settings?: Partial<DeskRuntimeSettings>;
          agentPrompts?: Partial<Record<AgentId, Partial<AgentPromptConfig>>>;
          llmApiKey?: string;
        }>(req);
        await desk.updateBoardConfig(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ai-config") {
      try {
        const parsed = await readJsonBody<{ instruction?: string }>(req);
        const summary = parsed.instruction ? await desk.applyAiConfigFromBoard(parsed.instruction) : "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, summary }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/train") {
      try {
        const parsed = await readJsonBody<{ style?: "scalping" | "daytrade" | "longtrade" }>(req);
        const report = await desk.runHistoricalTraining(parsed.style);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, report }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/optimize") {
      try {
        const parsed = await readJsonBody<{ symbol?: string }>(req);
        const report = await desk.runParameterOptimization(parsed.symbol);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, report }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/journal") {
      try {
        const parsed = await readJsonBody<{
          ticketId: string;
          journalNotes?: string;
          journalTags?: string[];
          setupGrade?: "A+" | "A" | "B" | "C";
        }>(req);
        const ok = desk.updateJournalEntry(parsed.ticketId, parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }

    const readJsonPayload = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    };

    if (req.method === "POST" && url.pathname === "/webhook/macro") {
      try {
        const body = await readJsonPayload();
        const impact = body.impact === "HIGH" || body.impact === "MED" || body.impact === "LOW" ? body.impact : "MED";
        const out = await desk.ingestMacroWebhook({
          event: String(body.event || "MACRO_EVENT"),
          actual: Number(body.actual ?? 0),
          forecast: Number(body.forecast ?? 0),
          previous: Number(body.previous ?? 0),
          timestamp: Number(body.timestamp ?? Date.now()),
          impact,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook/fomo") {
      try {
        const body = await readJsonPayload();
        const side = String(body.side || "LONG").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
        const out = await desk.ingestFomoWebhook({
          traderId: String(body.traderId || "unknown"),
          winRate: Number(body.winRate ?? 0),
          symbol: String(body.symbol || "BTCUSDT"),
          side,
          entryPrice: Number(body.entryPrice ?? 0),
          leverage: Number(body.leverage ?? 1),
          timestamp: Number(body.timestamp ?? Date.now()),
        });
        res.writeHead(out.accepted ? 200 : 202, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/grpo-train") {
      try {
        const body = await readJsonPayload();
        const parseDateStr = (v: unknown): number | undefined => {
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v !== "string" || !v.trim()) return undefined;
          const s = v.trim();
          const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
          if (m) {
            return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
          }
          const t = Date.parse(s);
          return Number.isFinite(t) ? t : undefined;
        };
        const symbol = typeof body.symbol === "string" && body.symbol.trim() ? body.symbol.trim().toUpperCase() : undefined;
        const startTs = parseDateStr(body.startTs ?? body.startDate);
        const endTs = parseDateStr(body.endTs ?? body.endDate);
        const out = await desk.runGrpoTraining(symbol, startTs, endTs);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/grpo-reload") {
      try {
        const memory = await desk.reloadGrpoPolicy();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, memory }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/rl-memory") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, memory: desk.grpo.memory, summary: desk.state.rlSummary }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mt5-bridge/poll") {
      await desk.syncWithLocalMt5Bridge();
      const payload = Mt5CloudBridge.buildLocalBridgePayload(
        desk.state.tickets,
        desk.state.settings.mt5DefaultLots ?? 0.05,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mt5-bridge/sync") {
      try {
        const out = await desk.resetAndSyncToMt5();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mt5-bridge/ea.mq5") {
      const host = req.headers.host || "localhost:4080";
      const code = Mt5CloudBridge.generateMql5ExpertAdvisor(`http://${host}`);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="TradingFloorBridge.mq5"',
      });
      res.end(code);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mobile-config") {
      try {
        const body = await readJsonPayload();
        const action = String(body.action || "") as
          | "SAVE_AND_TEST_TELEGRAM"
          | "DETECT_TELEGRAM_CHAT_ID"
          | "SAVE_AND_TEST_MT5"
          | "TEST_MT5_ORDER";
        const out = await desk.configureMobileIntegrations({
          action,
          tgChatId: typeof body.tgChatId === "string" ? body.tgChatId : undefined,
          tgTokens: typeof body.tgTokens === "object" && body.tgTokens !== null ? (body.tgTokens as Record<string, string>) : undefined,
          mt5Enabled: typeof body.mt5Enabled === "boolean" ? body.mt5Enabled : undefined,
          metaApiToken: typeof body.metaApiToken === "string" ? body.metaApiToken : undefined,
          metaApiAccountId: typeof body.metaApiAccountId === "string" ? body.metaApiAccountId : undefined,
          mt5Login: typeof body.mt5Login === "string" ? body.mt5Login : undefined,
          mt5Password: typeof body.mt5Password === "string" ? body.mt5Password : undefined,
          mt5Server: typeof body.mt5Server === "string" ? body.mt5Server : undefined,
          mt5DefaultLots: body.mt5DefaultLots !== undefined ? Number(body.mt5DefaultLots) : undefined,
          testSymbol: typeof body.testSymbol === "string" ? body.testSymbol : undefined,
          testSide: body.testSide === "short" ? "short" : "long",
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/autopilot") {
      try {
        const body = await readJsonPayload();
        const symbol = typeof body.symbol === "string" && body.symbol.trim() ? body.symbol.trim().toUpperCase() : undefined;
        const out = await desk.runOneClickAutoPilot(symbol);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/emergency") {
      try {
        const body = await readJsonPayload();
        const action = String(body.action || "").toUpperCase();
        if (action === "EMERGENCY_LIQUIDATE_ALL") {
          const out = await desk.emergencyLiquidateAll();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }
        if (action === "EXECUTION_HALTED_MANUAL") {
          const out = await desk.toggleManualHalt(true);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }
        if (action === "RESUME_DESK") {
          const out = await desk.toggleManualHalt(false);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Unsupported emergency action" }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/candles") {
      try {
        const sym = url.searchParams.get("symbol") || desk.state.settings.symbols[0] || "BTCUSDT";
        const rawTf = url.searchParams.get("interval") || "15m";
        const interval = /^[0-9]+(s|m|h|d|j|w|M|sem|mois)$/.test(rawTf) ? rawTf : "15m";
        const limit = Number(url.searchParams.get("limit") || 240);
        const data = await desk.getChartCandles(sym, interval, limit);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  server.listen(port, "0.0.0.0");

  return {
    url: `http://localhost:${port}`,
    close: () => {
      unsub();
      for (const c of clients) c.end();
      server.close();
    },
  };
}
