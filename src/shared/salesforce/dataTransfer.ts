import type { FieldInfo, ObjectDescribe } from './metadata';

export type ImportOperation = 'insert' | 'update' | 'upsert';

export interface CsvTable { headers: string[]; rows: string[][] }
export interface RowIssue { row: number; field?: string; message: string }

/** RFC 4180-style parser. CSV data stays in memory and is never persisted by this module. */
export function parseCsv(text: string): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(value); value = ''; }
    else if (c === '\n') { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += c;
  }
  if (quoted) throw new Error('CSV has an unclosed quoted value.');
  if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v !== ''));
  const headers = (nonEmpty.shift() ?? []).map((h) => h.trim());
  if (!headers.length || headers.some((h) => !h)) throw new Error('CSV needs a non-empty header row.');
  if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length) throw new Error('CSV header names must be unique.');
  return { headers, rows: nonEmpty.map((r) => headers.map((_, i) => r[i] ?? '')) };
}

export function autoMap(headers: string[], fields: FieldInfo[], operation: ImportOperation): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const normalized = h.trim().toLowerCase();
    const f = fields.find((x) => (x.name.toLowerCase() === normalized || x.label.toLowerCase() === normalized) &&
      (operation === 'insert' ? x.createable : x.updateable || x.name === 'Id'));
    if (f) out[h] = f.name;
  }
  return out;
}

function convert(raw: string, f: FieldInfo): unknown {
  if (raw === '') return null;
  if (f.type === 'boolean') {
    if (/^(true|1|yes)$/i.test(raw)) return true;
    if (/^(false|0|no)$/i.test(raw)) return false;
    throw new Error('must be true/false, yes/no, or 1/0');
  }
  if (['int', 'double', 'currency', 'percent'].includes(f.type)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error('must be a number');
    return n;
  }
  if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error('must use YYYY-MM-DD');
  if (f.type === 'datetime' && Number.isNaN(Date.parse(raw))) throw new Error('must be a valid date and time');
  if ((f.length ?? 0) > 0 && raw.length > f.length) throw new Error(`exceeds ${f.length} characters`);
  if (f.restrictedPicklist && !f.picklistValues.some((p) => p.active && p.value === raw)) throw new Error('is not an allowed picklist value');
  return raw;
}

export function prepareImport(table: CsvTable, describe: ObjectDescribe, mapping: Record<string, string>, operation: ImportOperation, externalIdField?: string) {
  const issues: RowIssue[] = [];
  const used = Object.values(mapping).filter(Boolean);
  if (new Set(used).size !== used.length) issues.push({ row: 0, message: 'Each Salesforce field can be mapped only once.' });
  const fieldByName = new Map(describe.fields.map((f) => [f.name, f]));
  if (operation === 'update' && !used.includes('Id')) issues.push({ row: 0, field: 'Id', message: 'Update requires a CSV column mapped to Id.' });
  if (operation === 'upsert' && (!externalIdField || !used.includes(externalIdField))) issues.push({ row: 0, field: externalIdField, message: 'Upsert requires the selected external ID field to be mapped.' });
  const records = table.rows.map((row, index) => {
    const rec: Record<string, unknown> = {};
    for (const [col, name] of Object.entries(mapping)) {
      if (!name) continue;
      const f = fieldByName.get(name);
      if (!f) continue;
      const raw = row[table.headers.indexOf(col)] ?? '';
      try { rec[name] = convert(raw, f); }
      catch (e) { issues.push({ row: index + 2, field: name, message: e instanceof Error ? e.message : String(e) }); }
    }
    for (const f of describe.fields) {
      if (operation === 'insert' && f.createable && !f.nillable && !f.defaultedOnCreate && !f.calculated && !f.autoNumber && !used.includes(f.name))
        issues.push({ row: index + 2, field: f.name, message: 'required field is not mapped' });
    }
    return rec;
  });
  return { records, issues };
}

export function csvCell(value: unknown): string {
  const s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  return `${columns.map(csvCell).join(',')}\r\n${rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')).join('\r\n')}\r\n`;
}

export function safeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid Salesforce API name: ${value}`);
  return value;
}
