// Currency, date, and math formatting utilities

export function round2(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  const snapped = Number(n.toPrecision(15));
  const base = Number.isFinite(snapped) ? snapped : n;
  const shifted = Number(`${base}e2`);
  if (!Number.isFinite(shifted)) return Math.round(base * 100) / 100;
  const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted));
  const result = Number(`${rounded}e-2`);
  return Object.is(result, -0) ? 0 : result;
}

export function formatLKR(value: number | string | null | undefined): string {
  const n = round2(value);
  return 'Rs. ' + n.toLocaleString('en-LK', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr).slice(0, 10);
    return d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return String(dateStr).slice(0, 10);
  }
}

export function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return String(dateStr);
    return d.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(dateStr);
  }
}
