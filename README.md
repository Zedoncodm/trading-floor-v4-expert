# 🏢 Trading Floor Desk & MetaTrader 5 Bridge

Plateforme autonome de trading multi-agents pour groupe Telegram et synchronisation bidirectionnelle en direct avec **MetaTrader 5 (MT5)**.

---

## 🚀 Fonctionnalités Clés

- **8 Agents Autonomes Spécialisés** :
  - `lead` : Responsable du desk et validation finale des ordres.
  - `macro` : Analyse macroéconomique et calendrier économique.
  - `crypto` : Spécialiste marchés crypto (BTC, ETH, SOL).
  - `technical` : Analyse technique, signaux chartistes, supports/résistances.
  - `risk` : Contrôle des risques, calcul des tailles de positions et stop-loss.
  - `execution` : Gestionnaire d'exécution des ordres et réconciliation.
  - `quant` : Analyse statistique et détection d'anomalies.
  - `sentiment` : Analyse du sentiment de marché et flux d'actualités.
- **Synchronisation Bidirectionnelle MT5** :
  - Lecture en temps réel du solde, de l'equity, du levier et de la marge libre du compte MT5.
  - Cotations Forex & Métaux en direct (EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, USDCAD, XAUUSD).
  - Réconciliation instantanée des ordres réels et du P&L non réalisé.
  - Synchronisation via passerelle locale sécurisée MQL5 (zéro dépendance externe).
- **Interface Web Temps Réel (Dashboard)** :
  - Suivi des agents en action.
  - Affichage en direct du solde, equity, trades actifs, PnL et statut MT5.
  - Bouton de synchronisation forcée instantanée.

---

## 📁 Structure du Projet

```
├── mql5/
│   ├── TradingFloorBridge.mq5   # Expert Advisor MT5 pour la passerelle locale
│   └── TradingFloorBridge.ex5   # Version compilée
├── src/
│   ├── config.ts               # Configuration et variables d'environnement
│   ├── desk.ts                 # Logique du desk de trading & réconciliation MT5
│   ├── main.ts                 # Point d'entrée principal et boucle de sync 1s
│   ├── mt5.ts                  # Passerelle bidirectionnelle avec le terminal MT5
│   ├── server.ts               # Serveur HTTP & API REST (/api/mt5-bridge/...)
│   ├── types.ts                # Définitions TypeScript (Tickets, Agents, DeskState)
│   └── ui.ts                   # Interface utilisateur web & dashboard réactif
├── test/                       # Tests unitaires automatisés
├── .env.example                # Exemple de configuration d'environnement
└── package.json
```

---

## 🛠️ Installation & Démarrage

### 1. Prérequis
- **Node.js** >= 23.6
- **MetaTrader 5** (avec trading algorithmique activé)

### 2. Installation des dépendances
```bash
npm install
```

### 3. Lancement du Desk
- **Mode simulation / console locale** (avec dashboard sur `http://localhost:4080`) :
  ```bash
  npm run sim
  ```

- **Mode production avec Telegram** :
  1. Copier `.env.example` en `.env` :
     ```bash
     cp .env.example .env
     ```
  2. Renseigner votre token de bot Telegram et `TELEGRAM_CHAT_ID`.
  3. Lancer :
     ```bash
     npm start
     ```

### 4. Configuration de l'Expert Advisor MT5
1. Copier `mql5/TradingFloorBridge.ex5` (ou `.mq5`) dans le dossier `MQL5\Experts\` de votre MetaTrader 5.
2. Dans MT5, activer **Trading Algorithmique**.
3. Glisser l'Expert Advisor `TradingFloorBridge` sur un graphique actif (ex: EURUSD).
4. Le pont s'active et synchronise automatiquement le capital et les positions avec le desk.

---

## 🧪 Tests

Exécuter la suite de tests unitaires :
```bash
npm test
```
