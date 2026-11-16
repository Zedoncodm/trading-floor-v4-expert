---
name: quant-walk-forward
description: >
  Directives strictes d'apprentissage financier basées sur Marcos López de Prado :
  interdiction du look-ahead bias, Walk-Forward Optimization (WFO) purgée (90j IS / 30j OOS),
  modélisation des coûts de transaction (Maker/Taker) et slippage, et boucle fermée runParameterOptimization().
---

# Quant Walk-Forward Skill

## 1. Interdiction absolue du Look-Ahead Bias
- Un signal calculé à la clôture de la bougie $t$ ne peut entrer en position qu'à l'ouverture de la bougie $t+1$ (`bars[i + 1].open`) ou sur niveau `LIMIT` postérieur.
- Aucun calcul d'ATR, de VWAP, d'Initial Balance ou de canal ne doit jamais consulter les bougies $\ge t+1$.

## 2. Walk-Forward Optimization (WFO) Purgée (90j IS / 30j OOS)
- La série historique est découpée en fenêtres glissantes **In-Sample (75% / 90j)** et **Out-Of-Sample (25% / 30j)**.
- **Purge des données chevauchantes (Purged Cross-Validation)** :
  - Toute position initiée dans la fenêtre In-Sample dont la sortie (`exitBar`) dépasse ou chevauche la frontière `splitIdx` est **purgée** (tronquée ou exclue avant `splitIdx`) et une zone d'embargo de sécurité est respectée avant d'évaluer la première bougie Out-Of-Sample.
  - Cela élimine toute fuite d'information sérielle entre l'entraînement et le test hors-échantillon.

## 3. Modélisation des Coûts de Friction Réels
Sur chaque trade simulé (backtest et paper trading) :
- **Frais d'exécution** :
  - Entrée/sortie au marché (Taker) : `0.04%` (`0.0004`) par côté (soit `0.08%` aller-retour).
  - Entrée `LIMIT` (Maker, ex. `Macro_FVG_Mitigation`) : `0.02%` (`0.0002`) à l'entrée + `0.04%` en sortie si stop/time-stop.
- **Slippage dynamique** : proportionnel à l'ATR courant ($Slippage = k \cdot \frac{\text{ATR}(14)}{\text{Prix}}$) appliqué défavorablement à l'entrée et à la sortie au marché.
- **Conversion en R-multiples nets** : les frais et le slippage sont déduits en dollars puis divisés par le risque initial (`riskUsd`), donnant l'espérance nette réelle.

## 4. Critères d'Acceptation WFO & Boucle Fermée (`runParameterOptimization`)
- Critères standards d'acceptation WFO d'un setup :
  - **Profit Factor net** $\ge 1.20$
  - **Espérance nette** $\ge +0.15R$
  - **Validation DSR** pour rejeter les paramètres sur-optimisés.
- **Boucle fermée `Trade Reviewer` $\to$ `Strategist` (`runParameterOptimization`)** :
  - À la fin du cycle ou manuellement via la commande `optimiser` / l'endpoint `/api/optimize`, le `Trade Reviewer` compile le taux de stops touchés, le taux de sorties en time-stop et le drawdown par stratégie.
  - Le `Strategist` effectue une recherche sur grille (Grid Search) des hyper-paramètres (`OFI_ZScore_Threshold`, `Fixed_Stop_ATR`, `FVG_Min_Size_ATR`) sur la fenêtre In-Sample purgée, puis **ne conserve la mise à jour que si elle améliore strictement le score Out-Of-Sample**.
