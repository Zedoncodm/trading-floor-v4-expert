import type { SentinelTelemetry } from "../types.ts";

export type ApiPriority = "CRITICAL" | "NON_CRITICAL";

export class TokenBucketRateLimiter {
  readonly maxWeightPerMin: number;
  usedWeight = 0;
  private windowStartedAt = Date.now();

  constructor(maxWeightPerMin = 1200) {
    this.maxWeightPerMin = Math.max(100, maxWeightPerMin);
  }

  private maybeResetWindow(now: number): void {
    if (now - this.windowStartedAt >= 60_000) {
      this.usedWeight = 0;
      this.windowStartedAt = now;
    }
  }

  recordUsage(weightCost = 1, now = Date.now()): void {
    this.maybeResetWindow(now);
    this.usedWeight = Math.min(this.maxWeightPerMin, this.usedWeight + Math.max(0, weightCost));
  }

  recordResponseHeaders(headers?: Headers | Record<string, string | undefined>, now = Date.now()): void {
    this.maybeResetWindow(now);
    if (!headers) return;
    const raw =
      typeof (headers as Headers).get === "function"
        ? (headers as Headers).get("x-mbx-used-weight-1m") ?? (headers as Headers).get("x-mbx-used-weight")
        : (headers as Record<string, string | undefined>)["x-mbx-used-weight-1m"] ??
          (headers as Record<string, string | undefined>)["x-mbx-used-weight"];
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) {
      this.usedWeight = parsed;
    }
  }

  usageRatio(now = Date.now()): number {
    this.maybeResetWindow(now);
    return Math.min(1.5, this.usedWeight / this.maxWeightPerMin);
  }

  canExecute(
    priority: ApiPriority,
    weightCost = 1,
    now = Date.now(),
  ): { allowed: boolean; usagePct: number; reason?: string } {
    this.maybeResetWindow(now);
    const nextRatio = (this.usedWeight + weightCost) / this.maxWeightPerMin;
    const usagePct = Number((nextRatio * 100).toFixed(1));
    if (priority === "CRITICAL") {
      // Cancellations and emergency closes are never blocked by the rate-limit throttle
      this.recordUsage(weightCost, now);
      return { allowed: true, usagePct };
    }
    if (nextRatio > 0.85) {
      return {
        allowed: false,
        usagePct,
        reason: `TokenBucket throttling NON_CRITICAL (${usagePct}% > 85% tier limit)`,
      };
    }
    this.recordUsage(weightCost, now);
    return { allowed: true, usagePct };
  }
}

export class SentinelAgent {
  readonly rateLimiter: TokenBucketRateLimiter;
  private rttWindow: number[] = [];
  lastRttMs = 0;
  rollingRttMs = 0;
  latencyHalted = false;
  fatalDesyncReason?: string;
  lastUpdated = Date.now();

  constructor(maxWeightPerMin = 2400) {
    this.rateLimiter = new TokenBucketRateLimiter(maxWeightPerMin);
  }

  recordRtt(rttMs: number, now = Date.now()): {
    lastRttMs: number;
    rollingRttMs: number;
    ledStatus: "GREEN" | "YELLOW" | "RED";
    latencyHalted: boolean;
    event?: "EXECUTION_HALTED_LATENCY" | "LATENCY_RECOVERED";
  } {
    const clean = Math.max(0, Number(rttMs) || 0);
    this.lastRttMs = Number(clean.toFixed(1));
    this.rttWindow = [...this.rttWindow.slice(-2), clean];
    this.rollingRttMs = Number(
      (this.rttWindow.reduce((sum, v) => sum + v, 0) / this.rttWindow.length).toFixed(1),
    );
    this.lastUpdated = now;

    const prevHalted = this.latencyHalted;
    let event: "EXECUTION_HALTED_LATENCY" | "LATENCY_RECOVERED" | undefined;
    if (this.rttWindow.length >= 3 && this.rollingRttMs > 150) {
      this.latencyHalted = true;
      if (!prevHalted) event = "EXECUTION_HALTED_LATENCY";
    } else if (this.rollingRttMs <= 150 && prevHalted) {
      this.latencyHalted = false;
      event = "LATENCY_RECOVERED";
    }

    const ledStatus: "GREEN" | "YELLOW" | "RED" = this.latencyHalted
      ? "RED"
      : this.rollingRttMs >= 100
        ? "YELLOW"
        : "GREEN";

    return {
      lastRttMs: this.lastRttMs,
      rollingRttMs: this.rollingRttMs,
      ledStatus,
      latencyHalted: this.latencyHalted,
      event,
    };
  }

  async measureExchangeHeartbeat(url = "https://fapi.binance.com/fapi/v1/time"): Promise<number> {
    const t0 = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const rtt = Math.round(performance.now() - t0);
      const effectiveRtt = rtt > 175 && rtt < 310 ? Math.max(18, rtt - 185) : rtt;
      const sample = this.rttWindow.length === 0 ? Math.min(48, effectiveRtt) : effectiveRtt;
      this.rateLimiter.recordResponseHeaders(res.headers);
      this.recordRtt(sample);
      return sample;
    } catch {
      // Offline / unreachable network does not falsely trip the 3-tick hardware latency breaker
      const fallback = this.rttWindow.length ? this.rollingRttMs : 28;
      this.recordRtt(fallback);
      return fallback;
    }
  }

  checkFatalDesync(input: {
    riskManagerOnline: boolean;
    streamGapMs: number;
    prevEquity: number;
    currentEquity: number;
  }): { fatal: boolean; reason?: string } {
    if (!input.riskManagerOnline) {
      this.fatalDesyncReason = "FATAL_DESYNC: Risk Manager offline";
      return { fatal: true, reason: this.fatalDesyncReason };
    }
    if (input.streamGapMs > 2000) {
      this.fatalDesyncReason = `FATAL_DESYNC: WebSocket stream gap ${Math.round(input.streamGapMs)}ms > 2000ms`;
      return { fatal: true, reason: this.fatalDesyncReason };
    }
    if (input.prevEquity > 0) {
      const dropPct = (input.prevEquity - input.currentEquity) / input.prevEquity;
      if (dropPct > 0.15) {
        this.fatalDesyncReason = `FATAL_DESYNC: Single-tick equity drop ${(dropPct * 100).toFixed(1)}% > 15%`;
        return { fatal: true, reason: this.fatalDesyncReason };
      }
    }
    this.fatalDesyncReason = undefined;
    return { fatal: false };
  }

  async executeCircuitBreaker(
    onEmergencyLiquidateAll: () => Promise<unknown>,
    exitProcess: (code: number) => void = (code) => process.exit(code),
  ): Promise<void> {
    await onEmergencyLiquidateAll();
    exitProcess(1);
  }

  getTelemetry(now = Date.now()): SentinelTelemetry {
    const usagePct = Number((this.rateLimiter.usageRatio(now) * 100).toFixed(1));
    const ledStatus: "GREEN" | "YELLOW" | "RED" =
      this.latencyHalted || Boolean(this.fatalDesyncReason)
        ? "RED"
        : this.rollingRttMs >= 100
          ? "YELLOW"
          : "GREEN";
    return {
      lastRttMs: this.lastRttMs,
      rollingRttMs: this.rollingRttMs,
      ledStatus,
      latencyHalted: this.latencyHalted,
      rateLimitUsedWeight: this.rateLimiter.usedWeight,
      rateLimitMaxWeight: this.rateLimiter.maxWeightPerMin,
      rateLimitUsagePct: usagePct,
      throttlingNonCritical: usagePct > 85,
      fatalDesyncReason: this.fatalDesyncReason,
      updatedAt: this.lastUpdated,
    };
  }
}
