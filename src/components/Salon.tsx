import type React from "react";
import type { ChatMessage } from "../types.ts";

export type SalonChannel = "floor-general" | "risk-veto" | "macro-alerts" | "liquidity-l2";

export interface SalonProps {
  messages: ChatMessage[];
  activeChannel: SalonChannel;
  onSelectChannel: (channel: SalonChannel) => void;
}

export function routeMessageToChannel(msg: ChatMessage): SalonChannel {
  const upper = (msg.text || "").toUpperCase();
  if (msg.speaker === "risk" || msg.tone === "veto" || upper.includes("VETO") || upper.includes("LEVIER")) {
    return "risk-veto";
  }
  if (msg.speaker === "analyst" || upper.includes("MACRO") || upper.includes("SENTIMENT")) {
    return "macro-alerts";
  }
  if (msg.speaker === "hunter" || upper.includes("SPOOFING") || upper.includes("LIQUIDITY") || upper.includes("L2")) {
    return "liquidity-l2";
  }
  return "floor-general";
}

export const Salon: React.FC<SalonProps> = ({ messages, activeChannel, onSelectChannel }) => {
  const filtered =
    activeChannel === "floor-general"
      ? messages
      : messages.filter((m) => routeMessageToChannel(m) === activeChannel);

  return (
    <div className="flex h-[calc(100vh-64px)] mt-16 gap-4 p-4 bg-[#050811] text-neutral-100">
      <aside className="w-60 rounded-2xl bg-neutral-900/60 backdrop-blur-xl border border-neutral-800 p-3 flex flex-col gap-2">
        {(["floor-general", "risk-veto", "macro-alerts", "liquidity-l2"] as SalonChannel[]).map((ch) => (
          <button
            key={ch}
            type="button"
            onClick={() => onSelectChannel(ch)}
            className={`text-left px-3 py-2 rounded-xl text-xs font-mono transition-colors ${
              activeChannel === ch
                ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                : "text-neutral-400 hover:bg-neutral-800/60"
            }`}
          >
            # {ch}
          </button>
        ))}
      </aside>

      <main className="flex-1 rounded-2xl bg-neutral-900/50 backdrop-blur-xl border border-neutral-800 p-4 overflow-y-auto space-y-3">
        {filtered.map((m) => (
          <div
            key={m.id}
            className="rounded-2xl px-4 py-3 bg-neutral-950/70 border border-neutral-800/80 shadow-md"
          >
            <div className="flex items-center justify-between text-[11px] font-mono mb-1">
              <span className="font-bold text-sky-400 uppercase">{m.speaker}</span>
              <span className="text-neutral-500">{new Date(m.at).toLocaleTimeString("fr-FR")}</span>
            </div>
            <div className="text-xs text-neutral-200 font-sans leading-relaxed">{m.text}</div>
          </div>
        ))}
      </main>
    </div>
  );
};

export default Salon;
