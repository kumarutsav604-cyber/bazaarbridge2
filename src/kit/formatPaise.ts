/**
 * Formats integer paise into Indian Rupee currency string.
 * Money is always integer paise in JSON; never use floats for calculations.
 */
export function formatPaise(paise: number | string | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  const num = typeof paise === 'string' ? parseInt(paise, 10) : paise;
  if (!Number.isFinite(num)) return '—';
  const rupees = num / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: num % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}
