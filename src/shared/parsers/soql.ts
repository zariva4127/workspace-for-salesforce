/**
 * Helpers for the read-only SOQL workspace: validation, result flattening,
 * and CSV export. The REST /query endpoint cannot modify data, but we still
 * validate input so users get clear feedback before a request is sent.
 */

export interface SoqlValidation {
  ok: boolean;
  error?: string;
  objectName?: string;
  hasLimit: boolean;
}

/** Builds a simple, read-only SELECT from API names returned by describe metadata. */
export function buildSelectQuery(objectApiName: string, fields: string[], limit = 100): string {
  const apiName = /^[A-Za-z][A-Za-z0-9_]*$/;
  if (!apiName.test(objectApiName)) throw new Error('Choose a valid Salesforce object.');
  const unique = [...new Set(fields)].filter((field) => apiName.test(field));
  if (!unique.length) throw new Error('Select at least one field.');
  const safeLimit = Math.max(1, Math.min(50_000, Math.trunc(limit) || 100));
  return `SELECT ${unique.join(', ')} FROM ${objectApiName} LIMIT ${safeLimit}`;
}

/** Strips string literals and comments so keyword checks don't match inside them. */
function stripLiterals(q: string): string {
  return q.replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function validateSoql(query: string): SoqlValidation {
  const q = query.trim();
  if (!q) return { ok: false, error: 'Enter a SOQL query.', hasLimit: false };
  const bare = stripLiterals(q);
  if (!/^select\b/i.test(bare)) {
    return { ok: false, error: 'Only SELECT queries are supported. This workspace is read-only.', hasLimit: false };
  }
  if (/;\s*\S/.test(bare)) return { ok: false, error: 'Run one query at a time (remove the semicolon).', hasLimit: false };
  // Only look at the top level (outside parentheses) so subqueries don't match FROM/LIMIT.
  let depth = 0;
  let top = '';
  for (const ch of bare) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0) top += ch;
  }
  const from = /\bfrom\s+([A-Za-z][\w]*)/i.exec(top);
  if (!from) return { ok: false, error: 'The query needs a FROM clause.', hasLimit: false };
  return { ok: true, objectName: from[1]!, hasLimit: /\blimit\s+\d+/i.test(top) };
}

type Rec = Record<string, unknown>;

/**
 * Flattens nested relationship fields (Account.Owner.Name) into dotted columns and
 * summarizes child subquery results as counts. Drops the `attributes` metadata.
 */
export function flattenRecord(record: Rec, prefix = '', out: Rec = {}): Rec {
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue;
    const col = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const v = value as Rec;
      if (Array.isArray(v.records)) {
        out[col] = `[${(v.totalSize as number | undefined) ?? v.records.length} child records]`;
      } else if ('attributes' in v || Object.keys(v).length) {
        flattenRecord(v, col, out);
      } else {
        out[col] = null;
      }
    } else {
      out[col] = value;
    }
  }
  return out;
}

export function flattenRecords(records: Rec[]): { columns: string[]; rows: Rec[] } {
  const rows = records.map((r) => flattenRecord(r));
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  return { columns, rows };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Neutralize spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Rec[]): string {
  return [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n');
}
