export function fmtPx(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const digits = n >= 1000 ? 1 : n >= 100 ? 2 : n >= 1 ? 3 : 5;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtUsd(n: number, digits = 0): string {
  const sign = n < 0 ? "-" : "";
  const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${sign}$${body}`;
}

export function fmtSignedUsd(n: number, digits = 0): string {
  if (Math.abs(n) < 0.5 * 10 ** -digits) return fmtUsd(0, digits);
  return n > 0 ? `+${fmtUsd(n, digits)}` : fmtUsd(n, digits);
}

export function fmtPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtSignedPct(fraction: number | null, digits = 2): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  return `${fraction > 0 ? "+" : ""}${(fraction * 100).toFixed(digits)}%`;
}

export function fmtFunding(f: number | null): string {
  if (f == null) return "—";
  return `${f > 0 ? "+" : ""}${(f * 100).toFixed(4)}%`;
}

export function fmtR(r: number): string {
  return `${r > 0 ? "+" : ""}${r.toFixed(2)}R`;
}

export function fmtCompactUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return fmtUsd(n);
}

export function fmtQty(qty: number): string {
  const digits = qty >= 100 ? 2 : qty >= 1 ? 3 : 5;
  return qty.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$/, "");
}

export function dirLabel(d: "long" | "short"): string {
  return d === "long" ? "LONG (achat)" : "SHORT (vente)";
}
