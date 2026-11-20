export function formatDuration(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatMiles(miles: number, digits = 0): string {
  return `${miles.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} mi`;
}

export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatLoad(lb: number): string {
  return `${formatNumber(lb)} lb`;
}

const timeFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const timeTzFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});
const dayFmt = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

/** "Fri 3:40 PM" in the viewer's time zone. */
export function formatTime(value: string | number | Date, withZone = false): string {
  const d = value instanceof Date ? value : new Date(value);
  return (withZone ? timeTzFmt : timeFmt).format(d);
}

export function formatDay(value: string | number | Date): string {
  return dayFmt.format(value instanceof Date ? value : new Date(value));
}

export function formatOffset(hours: number): string {
  const sign = hours < 0 ? '−' : '+';
  const minutes = Math.round(Math.abs(hours) * 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `T${sign}${h}h${String(m).padStart(2, '0')}` : `T${sign}${h}h`;
}

/** `<input type="datetime-local">` value for a Date, in local time. */
export function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** Parse a datetime-local value as local time; null if invalid. */
export function fromLocalInputValue(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Next quarter hour from `now` (a sensible default departure). */
export function nextQuarterHour(now = new Date()): Date {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
  return d;
}

export function localTimeZoneName(): string {
  const parts = timeTzFmt.formatToParts(new Date());
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'local time';
}

/** Fixed decimals using the classifier's rounding, so displayed values match risk levels. */
export function fixed(value: number, digits: number): string {
  const f = 10 ** digits;
  return (Math.floor(value * f + 0.5) / f).toFixed(digits);
}
