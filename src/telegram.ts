import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, AGENT_NAMES, type AgentId } from "./types.ts";
import type { Config } from "./config.ts";
import { errMsg } from "./http.ts";

export type IncomingTelegramCommand = {
  updateId: number;
  chatId: string;
  userId: number;
  username: string;
  text: string;
  at: number;
};

type TgResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; title?: string; type: string };
    from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
    text?: string;
  };
};

export class TelegramFloorRoom {
  private readonly cfg: Config;
  private readonly cfgPath: string;
  private botUsernames: Partial<Record<AgentId, string>> = {};
  public connected = false;

  constructor(cfg: Config) {
    this.cfg = cfg;
    mkdirSync(this.cfg.dataDir, { recursive: true });
    this.cfgPath = join(this.cfg.dataDir, "tg_config.json");
    this.loadSavedCredentials();
  }

  private loadSavedCredentials(): void {
    if (!existsSync(this.cfgPath)) return;
    try {
      const saved = JSON.parse(readFileSync(this.cfgPath, "utf8")) as {
        chatId?: string;
        humanUserId?: number;
        tokens?: Partial<Record<AgentId, string>>;
      };
      if (saved.chatId && (!this.cfg.chatId || this.cfg.chatId === "console")) {
        this.cfg.chatId = saved.chatId;
      }
      if (saved.humanUserId && !this.cfg.humanUserId) this.cfg.humanUserId = saved.humanUserId;
      if (saved.tokens) {
        for (const id of AGENT_IDS) {
          if (!this.cfg.tokens[id] && saved.tokens[id]) {
            this.cfg.tokens[id] = saved.tokens[id]!.trim();
          }
        }
      }
    } catch {
      // ignore corrupted config
    }
  }

  private saveCredentials(): void {
    const tmp = `${this.cfgPath}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          chatId: this.cfg.chatId,
          humanUserId: this.cfg.humanUserId,
          tokens: this.cfg.tokens,
        },
        null,
        2,
      ),
      "utf8",
    );
    renameSync(tmp, this.cfgPath);
  }

  updateCredentials(patch: {
    chatId?: string;
    humanUserId?: number;
    tokens?: Partial<Record<AgentId, string>>;
  }): void {
    if (patch.chatId !== undefined && patch.chatId.trim()) {
      this.cfg.chatId = patch.chatId.trim();
    }
    if (patch.humanUserId !== undefined && Number.isFinite(patch.humanUserId)) {
      this.cfg.humanUserId = patch.humanUserId;
    }
    if (patch.tokens) {
      for (const id of AGENT_IDS) {
        const val = patch.tokens[id];
        if (val !== undefined && val.trim() !== "") {
          this.cfg.tokens[id] = val.trim();
        }
      }
    }
    this.saveCredentials();
  }

  configuredBotCount(): number {
    return AGENT_IDS.filter((id) => Boolean(this.cfg.tokens[id])).length;
  }

  getPrimaryToken(): string {
    return this.cfg.tokens.lead || AGENT_IDS.map((id) => this.cfg.tokens[id]).find(Boolean) || "";
  }

  hasTokens(): boolean {
    return Boolean(this.getPrimaryToken()) && Boolean(this.cfg.chatId) && this.cfg.chatId !== "console";
  }

  async detectChatIdFromBot(): Promise<{ ok: boolean; chatId?: string; username?: string; message: string }> {
    const token = this.getPrimaryToken();
    if (!token) {
      return { ok: false, message: "Renseignez d'abord le Token du bot principal (@BotFather)." };
    }
    try {
      const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(6000) });
      const meData = (await meRes.json()) as TgResponse<{ username: string }>;
      if (!meData.ok || !meData.result) {
        return { ok: false, message: `Token Telegram invalide : ${meData.description ?? "getMe échoué"}` };
      }
      const updRes = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=25`, {
        signal: AbortSignal.timeout(6000),
      });
      const updData = (await updRes.json()) as TgResponse<TgUpdate[]>;
      const list = updData.result ?? [];
      const latestMsg = [...list].reverse().find((u) => u.message?.chat?.id);
      if (!latestMsg?.message?.chat?.id) {
        return {
          ok: false,
          username: meData.result.username,
          message: `Bot @${meData.result.username} valide ! Envoyez-lui un message (ex: "salut") sur votre téléphone puis recliquez ici pour détecter le Chat ID.`,
        };
      }
      const chatId = String(latestMsg.message.chat.id);
      const userId = latestMsg.message.from?.id ?? 0;
      this.updateCredentials({ chatId, humanUserId: userId || undefined });
      await this.verifyBots();
      await this.postAs("lead", "✅ Trading Floor V3 (8 Agents) connecté en direct à votre téléphone !");
      return {
        ok: true,
        chatId,
        username: meData.result.username,
        message: `Connecté à @${meData.result.username} (Chat ID: ${chatId}). Message de test envoyé sur votre téléphone !`,
      };
    } catch (e) {
      return { ok: false, message: `Erreur Telegram API : ${errMsg(e)}` };
    }
  }

  async verifyBots(): Promise<{ ok: boolean; details: string[] }> {
    const activeIds = AGENT_IDS.filter((id) => Boolean(this.cfg.tokens[id]));
    if (!activeIds.length || !this.cfg.chatId || this.cfg.chatId === "console") {
      this.connected = false;
      return {
        ok: false,
        details: ["Mode console / local actif (configurez Telegram depuis le bouton Mobile MT5 & Telegram)."],
      };
    }

    const details: string[] = [];
    let allOk = true;
    for (const id of activeIds) {
      const token = this.cfg.tokens[id];
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
          signal: AbortSignal.timeout(6000),
        });
        const data = (await res.json()) as TgResponse<{ username: string; first_name: string }>;
        if (data.ok && data.result) {
          this.botUsernames[id] = data.result.username;
          details.push(`✓ ${AGENT_NAMES[id]} → @${data.result.username}`);
        } else {
          allOk = false;
          details.push(`✗ ${AGENT_NAMES[id]} : ${data.description ?? "Token invalide"}`);
        }
      } catch (e) {
        allOk = false;
        details.push(`✗ ${AGENT_NAMES[id]} : ${errMsg(e)}`);
      }
    }
    this.connected = allOk && activeIds.length > 0;
    return { ok: this.connected, details };
  }

  /**
   * Posts into the configured Trading Floor group/DM chat.
   * Uses dedicated bot token if provided, or falls back to the primary bot prefixed with agent name.
   */
  async postAs(agent: AgentId, text: string): Promise<void> {
    if (!this.hasTokens()) return;
    const dedicated = this.cfg.tokens[agent];
    const token = dedicated || this.getPrimaryToken();
    if (!token) return;
    const payloadText = dedicated ? text : `[${AGENT_NAMES[agent]}]\n${text}`;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: this.cfg.chatId,
          text: payloadText,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // Non-fatal: message is still logged in the local Trading Floor UI
    }
  }

  /**
   * Poll updates using Desk Lead's (or primary) token.
   */
  async pollCommands(offset: number): Promise<{ nextOffset: number; commands: IncomingTelegramCommand[] }> {
    if (!this.hasTokens()) return { nextOffset: offset, commands: [] };
    const leadToken = this.getPrimaryToken();
    try {
      const url = `https://api.telegram.org/bot${leadToken}/getUpdates?offset=${offset}&timeout=1&allowed_updates=${encodeURIComponent(JSON.stringify(["message"]))}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const data = (await res.json()) as TgResponse<TgUpdate[]>;
      if (!data.ok || !data.result) return { nextOffset: offset, commands: [] };

      let nextOffset = offset;
      const commands: IncomingTelegramCommand[] = [];
      for (const u of data.result) {
        nextOffset = Math.max(nextOffset, u.update_id + 1);
        const msg = u.message;
        if (!msg || !msg.text || msg.from?.is_bot) continue;
        if (String(msg.chat.id) !== String(this.cfg.chatId)) continue;
        if (this.cfg.humanUserId > 0 && msg.from?.id !== this.cfg.humanUserId) continue;

        const cleaned = msg.text.replace(/^\/([a-zA-Z0-9_]+)@[a-zA-Z0-9_]+/, "$1").replace(/^\//, "").trim();
        commands.push({
          updateId: u.update_id,
          chatId: String(msg.chat.id),
          userId: msg.from?.id ?? 0,
          username: msg.from?.username ?? msg.from?.first_name ?? "Human",
          text: cleaned,
          at: msg.date * 1000,
        });
      }
      return { nextOffset, commands };
    } catch {
      return { nextOffset: offset, commands: [] };
    }
  }
}
