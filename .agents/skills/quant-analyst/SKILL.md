---
name: quant-analyst
description: >
  Règles de calcul vectorisé pour les métriques de performance institutionnelles :
  Value at Risk (VaR), Maximum Drawdown (MDD), Espérance mathématique en R-multiples,
  Critère de Kelly fractionné et Deflated Sharpe Ratio (DSR).
---

# Quant Analyst Skill

Ce module définit les formules mathématiques institutionnelles appliquées par le **Stratège Quant**, le **Directeur des Risques** et le **Trade Reviewer**.

## 1. Espérance Mathématique en R-multiples
Soit une série de rendements normalisés en risque unitaire $R_1, R_2, \dots, R_N$ (nets de frais et slippage) :
- **Espérance** : $E[R] = \frac{1}{N} \sum_{i=1}^{N} R_i$
- **Profit Factor** : $PF = \frac{\sum_{R_i > 0} R_i}{\left|\sum_{R_i < 0} R_i\right|}$

## 2. Maximum Drawdown (MDD) & Value at Risk (VaR)
Sur la courbe cumulative $C_t = \sum_{i=1}^{t} R_i$ (avec $C_0 = 0$) :
- **Peak glissant** : $P_t = \max_{0 \le s \le t} C_s$
- **MDD (en R)** : $\text{MDD}_R = \max_{t} (P_t - C_t)$
- **VaR Historique (95% / 99%)** : quantile empirique à $\alpha = 5\%$ (ou $1\%$) des rendements $R_i$ triés par ordre croissant (exprimé en perte positive ou R négatif).
- **VaR Paramétrique** : $\text{VaR}_\alpha = \mu_R + z_\alpha \cdot \sigma_R$ avec $z_{0.05} \approx -1.645$ et $z_{0.01} \approx -2.326$.

## 3. Deflated Sharpe Ratio (DSR — Bailey & López de Prado)
Le **Sharpe Ratio** non annualisé par trade est $SR = \frac{\mu_R}{\sigma_R}$ (annualisé selon la fréquence moyenne $K$ trades/an : $SR_{ann} = SR \cdot \sqrt{K}$).
Pour corriger les biais de tests multiples ($M$ essais / combinaisons testées), de skewness ($\gamma_3$) et de kurtosis ($\gamma_4$) :
1. Variance estimée du Sharpe Ratio :
   $$\sigma_{SR}^2 = \frac{1 - \gamma_3 \cdot SR + \frac{\gamma_4 - 1}{4} \cdot SR^2}{N - 1}$$
2. Sharpe Ratio attendu sous l'hypothèse nulle avec $M$ essais indépendants (approximation des valeurs extrêmes de Gumbel) :
   $$SR_0 = \sqrt{\frac{1}{N - 1}} \left[ (1 - \gamma_{euler}) \Phi^{-1}\left(1 - \frac{1}{M}\right) + \gamma_{euler} \Phi^{-1}\left(1 - \frac{1}{M e}\right) \right]$$
   (avec $\gamma_{euler} \approx 0.5772$).
3. Statistique DSR :
   $$DSR = \Phi\left( \frac{SR - SR_0}{\sigma_{SR}} \right) \in [0, 1]$$
   Un paramètre est considéré robuste statistiquement si $DSR \ge 0.50$ (et idéalement $\ge 0.65$).

## 4. Critère de Kelly Fractionné Plafonné (Risk Manager)
- **Kelly complet** : $f^* = \frac{p \cdot b - (1 - p)}{b}$ où $p$ est le taux de réussite et $b = \frac{\bar{R}_{gain}}{|\bar{R}_{perte}|}$.
- **Sizing dynamique modulé par le DSR Out-Of-Sample** :
  - On applique un Kelly fractionné (1/4 Kelly) modulé par $\text{DSR}_{OOS}$, strictement borné entre **`0.5%` (`0.005`)** et **`3.0%` (`0.030`)** max du capital par trade.
  - Plafonds absolus inchangés : **10%** d'exposition brute totale et **5%** de perte journalière max (passage immédiat à plat).
