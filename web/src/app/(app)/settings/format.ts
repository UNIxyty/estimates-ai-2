/** Money for usage figures: 2 decimals, but tiny non-zero amounts keep 4 so they don't read as $0.00. */
export function money(n: unknown): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v === 0) return '$0.00';
  if (Math.abs(v) < 0.0001) return '<$0.0001';
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Budget amounts: "$300" or "$250.50". */
export function budgetAmount(n: unknown): string {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? `$${v.toLocaleString('en-US')}` : `$${v.toFixed(2)}`;
}

export const TIER_LABEL: Record<string, string> = { fast: 'Fast', standard: 'Standard', advanced: 'Advanced' };
