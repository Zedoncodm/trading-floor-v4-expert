//+------------------------------------------------------------------+
//|                                           TradingFloorBridge.mq5 |
//|     Passerelle Bidirectionnelle v2.0 Trading Floor <-> MT5       |
//+------------------------------------------------------------------+
#property copyright "Trading Floor V3"
#property version   "2.00"
#include <Trade\Trade.mqh>

input string InpServerUrl   = "http://127.0.0.1:4080";
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
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", " ");
   StringReplace(out, "\n", " ");
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
   int p = StringFind(src, "\"" + key + "\":\"", startPos);
   if(p < 0) return "";
   p += StringLen(key) + 4;
   int e = StringFind(src, "\"", p);
   if(e < 0) return "";
   return StringSubstr(src, p, e - p);
}

double ExtractNum(const string src, const string key, int startPos) {
   int p = StringFind(src, "\"" + key + "\":", startPos);
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
   json += "\"connected\":true,";
   json += "\"timestamp\":" + IntegerToString((long)TimeGMT() * 1000) + ",";
   json += "\"serverTimestamp\":" + IntegerToString((long)TimeCurrent() * 1000) + ",";
   json += "\"login\":" + IntegerToString(login) + ",";
   json += "\"server\":\"" + JsonEscape(server) + "\",";
   json += "\"currency\":\"" + JsonEscape(curr) + "\",";
   json += "\"balance\":" + DoubleToString(bal, 2) + ",";
   json += "\"equity\":" + DoubleToString(eq, 2) + ",";
   json += "\"profit\":" + DoubleToString(prof, 2) + ",";
   json += "\"freeMargin\":" + DoubleToString(freeM, 2) + ",";
   json += "\"leverage\":" + IntegerToString(lev) + ",";
   json += "\"tradeAllowed\":" + (allowed ? "true" : "false") + ",";

   json += "\"positions\":[";
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
      json += "\"ticket\":" + IntegerToString((long)ticket) + ",";
      json += "\"id\":\"" + JsonEscape(pId) + "\",";
      json += "\"symbol\":\"" + JsonEscape(pSym) + "\",";
      json += "\"side\":\"" + pSide + "\",";
      json += "\"lots\":" + DoubleToString(pLots, 2) + ",";
      json += "\"entry\":" + DoubleToString(pEntry, digits) + ",";
      json += "\"current\":" + DoubleToString(pCurr, digits) + ",";
      json += "\"sl\":" + DoubleToString(pSl, digits) + ",";
      json += "\"tp\":" + DoubleToString(pTp, digits) + ",";
      json += "\"profit\":" + DoubleToString(pProf, 2) + ",";
      json += "\"magic\":" + IntegerToString(pMagic);
      json += "}";
   }
   json += "],";

   string quoteSyms[] = { "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "XAUUSD", "BTCUSD" };
   json += "\"quotes\":[";
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
      json += "\"symbol\":\"" + qSym + "\",";
      json += "\"brokerSymbol\":\"" + JsonEscape(realQ) + "\",";
      json += "\"bid\":" + DoubleToString(bid, qDigits) + ",";
      json += "\"ask\":" + DoubleToString(ask, qDigits) + ",";
      json += "\"tradeMode\":" + IntegerToString(tMode);
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
   bool tradeAllowed = (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0 && MQLInfoInteger(MQL_TRADE_ALLOWED) != 0);
   Print("TradingFloorBridge v2.0 initialise (chart=", DoubleToString(gMyMasterId, 0),
         ", login=", AccountInfoInteger(ACCOUNT_LOGIN),
         ", balance=", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2),
         ", tradeAllowed=", (tradeAllowed ? "true" : "false"), ").");
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
   if(StringFind(body, "\"openOrders\":[") < 0) return;

   string activeIds = "|";
   int cursor = 0;
   bool stateDirty = false;

   while(true) {
      int idPos = StringFind(body, "\"id\":\"", cursor);
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
      if(realSym == "") {
         Print("SYNCHRO MT5 -> Symbole introuvable sur ce broker: ", symRaw, " (ID=", id, ")");
         gFailedIds += id + "|";
         continue;
      }

      if(SymbolInfoInteger(realSym, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED) {
         Print("SYNCHRO MT5 -> Marche desactive pour ", realSym, " (ID=", id, ")");
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
            Print("SYNCHRO MT5 -> BUY OK ", realSym, " lots=", DoubleToString(normLots, 2), " @ ", DoubleToString(ask, digits), " ID=", id);
            stateDirty = true;
         } else {
            uint ret = trade.ResultRetcode();
            if(ret == TRADE_RETCODE_INVALID_STOPS || ret == 10016) {
               if(trade.Buy(normLots, realSym, ask, 0.0, 0.0, id)) {
                  ModifyPositionByComment(id, realSym, slPx, tpPx);
                  Print("SYNCHRO MT5 -> BUY OK (SL/TP post-modify) ", realSym, " lots=", DoubleToString(normLots, 2), " ID=", id);
                  stateDirty = true;
               } else {
                  Print("SYNCHRO MT5 -> Echec BUY ", realSym, " retcode=", trade.ResultRetcode(), " (", trade.ResultRetcodeDescription(), ")");
                  gFailedIds += id + "|";
               }
            } else {
               Print("SYNCHRO MT5 -> Refus BUY ", realSym, " retcode=", ret, " (", trade.ResultRetcodeDescription(), ") ID=", id);
               if(ret != TRADE_RETCODE_CLIENT_DISABLES_AT && ret != TRADE_RETCODE_SERVER_DISABLES_AT && ret != TRADE_RETCODE_CONNECTION) {
                  gFailedIds += id + "|";
               }
            }
         }
      } else if(side == "SELL" && bid > 0.0) {
         double slPx = (slDistRel > 0.0) ? NormalizeDouble(bid + MathMax(minDist, bid * slDistRel), digits) : 0.0;
         double tpPx = (tpDistRel > 0.0) ? NormalizeDouble(bid - MathMax(minDist, bid * tpDistRel), digits) : 0.0;
         if(trade.Sell(normLots, realSym, bid, slPx, tpPx, id)) {
            Print("SYNCHRO MT5 -> SELL OK ", realSym, " lots=", DoubleToString(normLots, 2), " @ ", DoubleToString(bid, digits), " ID=", id);
            stateDirty = true;
         } else {
            uint ret = trade.ResultRetcode();
            if(ret == TRADE_RETCODE_INVALID_STOPS || ret == 10016) {
               if(trade.Sell(normLots, realSym, bid, 0.0, 0.0, id)) {
                  ModifyPositionByComment(id, realSym, slPx, tpPx);
                  Print("SYNCHRO MT5 -> SELL OK (SL/TP post-modify) ", realSym, " lots=", DoubleToString(normLots, 2), " ID=", id);
                  stateDirty = true;
               } else {
                  Print("SYNCHRO MT5 -> Echec SELL ", realSym, " retcode=", trade.ResultRetcode(), " (", trade.ResultRetcodeDescription(), ")");
                  gFailedIds += id + "|";
               }
            } else {
               Print("SYNCHRO MT5 -> Refus SELL ", realSym, " retcode=", ret, " (", trade.ResultRetcodeDescription(), ") ID=", id);
               if(ret != TRADE_RETCODE_CLIENT_DISABLES_AT && ret != TRADE_RETCODE_SERVER_DISABLES_AT && ret != TRADE_RETCODE_CONNECTION) {
                  gFailedIds += id + "|";
               }
            }
         }
      }
   }

   for(int i = PositionsTotal() - 1; i >= 0; i--) {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetInteger(POSITION_MAGIC) == InpMagic) {
         string cmt = PositionGetString(POSITION_COMMENT);
         if(StringLen(cmt) > 0 && StringFind(activeIds, "|" + cmt + "|") < 0) {
            if(trade.PositionClose(ticket)) {
               Print("SYNCHRO MT5 -> Ordre cloture ticket=", ticket, " comment=", cmt);
               stateDirty = true;
            }
         }
      }
   }

   if(stateDirty) {
      WriteMt5StateToFile();
   }
}
//+------------------------------------------------------------------+
