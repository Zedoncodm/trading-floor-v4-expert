/**
 * Helper script: `npm run chat-id`
 * Lit les derniers messages reçus par le bot Desk Lead (TG_TOKEN_LEAD)
 * et affiche le TG_CHAT_ID du groupe "Trading Floor" ainsi que votre TG_HUMAN_USER_ID.
 */
const token = (process.env.TG_TOKEN_LEAD ?? "").trim();
if (!token) {
  console.error("Erreur : renseignez d'abord TG_TOKEN_LEAD dans votre fichier .env");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=25`);
const data = (await res.json()) as {
  ok: boolean;
  result?: Array<{
    message?: {
      chat: { id: number; title?: string; type: string };
      from?: { id: number; username?: string; first_name?: string };
      text?: string;
    };
  }>;
};

if (!data.ok || !data.result?.length) {
  console.log("Aucun message récent trouvé. Envoyez un message (ex: 'hello') dans le groupe Telegram 'Trading Floor' puis relancez `npm run chat-id`.");
  process.exit(0);
}

console.log("\nMessages détectés par Desk Lead :\n");
for (const u of data.result) {
  const m = u.message;
  if (!m) continue;
  console.log(`• Salon : "${m.chat.title ?? m.chat.type}" -> TG_CHAT_ID=${m.chat.id}`);
  if (m.from) {
    console.log(`  Auteur : ${m.from.first_name ?? ""} (@${m.from.username ?? ""}) -> TG_HUMAN_USER_ID=${m.from.id}`);
  }
}
