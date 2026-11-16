---
name: crypto-microstructure
description: >
  Logique de lecture des flux L2 (Order Book Imbalance), cascades de liquidation
  (Open Interest + Funding Rate), contrôle du spread en ticks, sélection adverse
  et maintien strict du verrou Execution Trader (refus des clés WITHDRAWAL).
---

# Crypto Microstructure & Execution Bridge Skill

## 1. Flux L2 & Order Flow Imbalance (`OFI`)
- Sources ingérées : **Binance Futures (`fapi.binance.com`)** et **Bybit Linear (`api.bybit.com`)** en 2e source obligatoire.
- Données ingérées : Bougies `1m`, `15m`, `1h`, `4h`, Carnet L2 Top 5 (`bids[0..4]`, `asks[0..4]`), `Funding Rate`, `Open Interest`.
- **Order Flow Imbalance (`OFI`)** :
  - Variation nette de la liquidité au meilleur Bid vs meilleur Ask et pondération des 5 premiers niveaux du carnet :
    $$\text{OFI}_t = \frac{\sum_{i=1}^5 w_i (V_{bid,i} - V_{ask,i})}{\sum_{i=1}^5 w_i (V_{bid,i} + V_{ask,i})}$$
    complété par le delta des meilleurs prix/tailles entre deux instants successifs.
- **Z-Score glissant (`OFI_Window = 60` secondes)** :
  $$Z_{OFI} = \frac{\text{OFI}_t - \mu_{60s}}{\sigma_{60s}}$$
- **Contrôle du spread et du volume** :
  - Contrôle que `Spread <= 2 ticks` (tolérance adaptée à la granularité tick de l'actif).
  - Contrôle d'impulsion : `Volume_Tick >= 3.0 * SMA(Volume, 20)`.
- **Protection contre la sélection adverse** :
  - Sortie d'urgence immédiate si `Z_OFI < -1.5` en position `LONG` ou `Z_OFI > +1.5` en position `SHORT`.
  - Take Profit dynamique dès épuisement du flux (`|Z_OFI| < 0.5`).

## 2. Cascades de Liquidation (`Liquidation_Cascade_Watch`)
- Lorsque le mouvement 1h dépasse `1.4%` (`|ret1h| > 0.014`) avec un Funding Rate déjà extrême (`|funding| > 0.00075`) du même côté :
  - Au lieu de bloquer le desk sur un conflit, le système active **`Liquidation_Cascade_Watch`**.
  - Les achats/ventes en cassure tardive (`breakout`) sont **bloqués**.
  - Priorité absolue au moteur `fade` ou à une entrée sur retracement `Macro_FVG_Mitigation` dès que l'Open Interest commence à purger (`oiChange1h < 0`).

## 3. Verrou de Sécurité Execution Trader
- L'`Execution Trader` est le **seul** agent autorisé à toucher un connecteur d'exchange.
- **Règle immuable** : refus strict et immédiat de toute clé API possédant la permission `WITHDRAWAL` (retrait). Seules les clés `trade-only` sont acceptées, et le mode `PAPER` reste actif sauf ordre explicite.
- Respect du mode choisi par l'opérateur : **Mode Full Auto** (`auto`) ou **Mode Confirmation Humaine** (`human_confirm`, approbation par ID exact).
