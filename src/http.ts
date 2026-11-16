const UA = "trading-floor-paper-desk/1.0";

function where(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "url";
  }
}

export async function getJson<T>(
  url: string,
  init: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(init.timeoutMs ?? 8000),
    headers: { "user-agent": UA, accept: "application/json", ...init.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${where(url)} ${body.slice(0, 120)}`);
  }
  return (await res.json()) as T;
}

export async function getText(url: string, timeoutMs = 8000): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml, */*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${where(url)}`);
  return res.text();
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
