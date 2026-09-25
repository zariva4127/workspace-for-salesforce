/**
 * Turns raw API values into readable text for the record detail page.
 * Rich text is converted to plain text (never rendered as HTML), and only
 * http(s)/mailto/tel links are produced.
 */
import type { FieldInfo } from '../salesforce/metadata';
import { formatFieldValue } from '../salesforce/records';

export interface DisplayContext {
  /** ISO currency of the record (multi-currency orgs) or the org's corporate currency. */
  currency?: string;
  locale?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCharCode(Number(e.slice(1))) : m))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A safe link target for a URL field value, or undefined when it isn't a web URL. */
export function safeHref(url: string): string | undefined {
  const v = url.trim();
  const withScheme = /^[a-z][\w+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function picklistLabels(f: FieldInfo, value: string): string[] {
  const labels = new Map(f.picklistValues.map((p) => [p.value, p.label]));
  return (f.type === 'multipicklist' ? value.split(';') : [value]).filter(Boolean).map((v) => labels.get(v) ?? v);
}

export function formatCurrency(value: number, ctx: DisplayContext = {}, scale = 2): string {
  if (ctx.currency) {
    try {
      return new Intl.NumberFormat(ctx.locale, { style: 'currency', currency: ctx.currency, maximumFractionDigits: Math.max(scale, 0) }).format(value);
    } catch {
      // Unknown currency code: fall through to a plain number.
    }
  }
  return value.toLocaleString(ctx.locale, { minimumFractionDigits: Math.min(scale, 2), maximumFractionDigits: Math.max(scale, 0) });
}

export function addressLines(v: unknown): string[] {
  if (!v || typeof v !== 'object') return [];
  const a = v as Record<string, unknown>;
  const cityLine = [a.city, [a.state ?? a.stateCode, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.street, cityLine, a.country ?? a.countryCode].filter((x): x is string => typeof x === 'string' && x.trim() !== '');
}

/** Plain-text rendering used for display, search, and copy-friendly titles. */
export function displayText(f: FieldInfo, value: unknown, ctx: DisplayContext = {}): string {
  if (value === null || value === undefined || value === '') return '';
  if (f.type === 'address') return addressLines(value).join(', ');
  if (f.type === 'picklist' || f.type === 'multipicklist') return picklistLabels(f, String(value)).join('; ');
  if (f.type === 'currency' && typeof value === 'number') return formatCurrency(value, ctx, f.scale);
  if ((f.type === 'textarea' || f.type === 'string') && f.htmlFormatted && typeof value === 'string') return htmlToText(value);
  if (f.type === 'base64') return '(file content)';
  return formatFieldValue(value, f.type, ctx.locale);
}
