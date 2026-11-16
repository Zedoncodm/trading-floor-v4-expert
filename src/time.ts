export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 = Monday … 7 = Sunday */
  weekday: number;
};

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string): LocalParts {
  const map: Record<string, string> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday: WEEKDAY[map.weekday] ?? 1,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function ticketDay(ms: number, tz: string): string {
  return dayKey(ms, tz).replaceAll("-", "");
}

export function isoWeek(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  date.setUTCDate(date.getUTCDate() + 4 - p.weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

export function isOvernight(ms: number, tz: string, start: number, end: number): boolean {
  const h = localParts(ms, tz).hour;
  if (start === end) return false;
  return start > end ? h >= start || h < end : h >= start && h < end;
}

export function clock(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function stamp(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${pad(p.day)}/${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
}
