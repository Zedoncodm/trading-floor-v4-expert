import { Mt5CloudBridge } from "./mt5.ts";
import { createInterface } from "node:readline";
import { ConfigError, loadConfig } from "./config.ts";
import { TradingFloorDesk } from "./desk.ts";
import { startDashboardServer } from "./server.ts";
import { DeskStore } from "./store.ts";
import { TelegramFloorRoom } from "./telegram.ts";
import { AGENT_NAMES } from "./types.ts";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n[Configuration Error] ${err.message}`);
      console.error(`Astuce : lancez "npm run sim" pour démarrer avec le Dashboard 3D sans tokens Telegram.\n`);
      process.exit(1);
    }
    throw err;
  }

  const store = new DeskStore(cfg.dataDir);
  const tg = new TelegramFloorRoom(cfg);
  const desk = new TradingFloorDesk(cfg, store, tg);

  const uiPort = Number(process.env.UI_PORT || 4080);
  const web = startDashboardServer(desk, uiPort);

  setInterval(() => {
    void desk.syncWithLocalMt5Bridge();
  }, 1000);

  console.log("==================================================================");
  console.log("  TRADING FLOOR · 6-BOT PAPER DESK + 3D LOCAL COMMAND");
  console.log("==================================================================");
  console.log(`  Mode d'exécution : PAPER ONLY (aucun retrait autorisé)`);
  console.log(`  Dashboard 3D Web : ${web.url}`);
  console.log(`  Blotter journal  : ${store.blotterPath}`);
  console.log("------------------------------------------------------------------");

  const botCheck = await tg.verifyBots();
  for (const line of botCheck.details) {
    console.log(`  ${line}`);
  }
  console.log("==================================================================\n");

  await desk.bootstrapIfFresh();
  if (Mt5CloudBridge.readLocalMt5State() && desk.state.tickets.some((t) => !t.mt5PositionId)) {
    await desk.resetAndSyncToMt5();
  }

  // Print new messages to terminal console as well
  let printedCount = desk.state.messages.length;
  desk.subscribe((st) => {
    while (printedCount < st.messages.length) {
      const m = st.messages[printedCount++];
      if (!m) break;
      const who = m.speaker === "human" ? "YOU" : AGENT_NAMES[m.speaker];
      console.log(`[${new Date(m.at).toLocaleTimeString("fr-FR")}] [${who}] ${m.text.replace(/\n/g, " | ")}`);
    }
  });

  // Periodic market monitor (5s fast loop for responsive paper scalp & stop/target tracking)
  setInterval(() => {
    void desk.monitorStep();
  }, Math.min(cfg.monitorIntervalSec, 5) * 1000);

  // Telegram group chat polling loop (checks live so UI token config activates immediately without restart)
  setInterval(async () => {
    if (!tg.hasTokens()) return;
    const { nextOffset, commands } = await tg.pollCommands(desk.state.tgOffset);
    if (nextOffset !== desk.state.tgOffset) {
      desk.state.tgOffset = nextOffset;
      store.save(desk.state);
    }
    for (const cmd of commands) {
      await desk.handleHumanInput(cmd.text, "telegram");
    }
  }, 2500);

  // Interactive terminal input (works alongside Web UI and Telegram)
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) void desk.handleHumanInput(trimmed, "desk");
    });
  }
}

void main();
