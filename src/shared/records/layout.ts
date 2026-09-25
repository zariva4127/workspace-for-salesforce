/**
 * Groups a record's readable fields into sections.
 *
 * Primary source: the page layout assigned to the user for the record's record
 * type (REST `describe/layouts`), so sections match what the user sees in
 * Salesforce. Readable fields that aren't on the layout go to "Other fields",
 * so nothing the user may read is hidden.
 *
 * Fallback (no layout API access, or the object has no layouts): logical
 * groups derived from field metadata.
 */
import type { FieldInfo } from '../salesforce/metadata';

export interface FieldSection {
  id: string;
  title: string;
  fields: FieldInfo[];
  /** Salesforce marks some layout sections collapsed by default (e.g. System Information). */
  collapsed: boolean;
}

export interface LayoutSummary {
  sections: Array<{ heading: string; collapsed: boolean; fields: string[] }>;
  /** Child relationship API names explicitly placed on the assigned page layout. */
  relatedLists: string[];
}

const MASTER_RT = '012000000000000AAA';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Accepts either `describe/layouts/` (with recordTypeMappings) or
 * `describe/layouts/{recordTypeId}` (a single layout) and returns the detail
 * layout sections for the record type.
 */
export function parseLayout(raw: any, recordTypeId?: string): LayoutSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  let layout: any = raw;
  if (Array.isArray(raw.layouts)) {
    const mappings: any[] = raw.recordTypeMappings ?? [];
    const rt = (recordTypeId ?? '').slice(0, 15);
    const mapping =
      mappings.find((m) => rt && String(m.recordTypeId ?? '').slice(0, 15) === rt) ??
      mappings.find((m) => m.defaultRecordTypeMapping) ??
      mappings.find((m) => String(m.recordTypeId ?? '').slice(0, 15) === MASTER_RT.slice(0, 15));
    layout = (mapping && raw.layouts.find((l: any) => l.id === mapping.layoutId)) ?? raw.layouts[0];
  }
  const sections: any[] = layout?.detailLayoutSections ?? [];
  const relatedLists = ((layout?.relatedLists ?? []) as any[])
    .map((list) => (typeof list?.name === 'string' ? list.name.trim() : ''))
    .filter(Boolean);
  if (!sections.length && !relatedLists.length) return undefined;
  return {
    sections: sections.map((sec) => {
      const fields: string[] = [];
      for (const row of sec.layoutRows ?? []) {
        for (const item of row.layoutItems ?? []) {
          for (const comp of item.layoutComponents ?? []) {
            // Compound fields (addresses) list their parts as nested components; the compound itself is shown.
            if (comp?.type === 'Field' && typeof comp.value === 'string') fields.push(comp.value);
          }
        }
      }
      return { heading: String(sec.heading ?? '').trim(), collapsed: !!sec.collapsed || sec.collapsible === 'collapsed', fields };
    }),
    relatedLists: [...new Set(relatedLists)],
  };
}

/** Field names from a compact layout (`describe/compactLayouts/primary`), used for the record header. */
export function parseCompactLayout(raw: any): string[] {
  const items: any[] = raw?.fieldItems ?? [];
  const out: string[] = [];
  for (const item of items) for (const c of item.layoutComponents ?? []) if (c?.type === 'Field' && typeof c.value === 'string') out.push(c.value);
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A field is shown if the REST record response returned it (i.e. the user can read it). */
function readable(values: Record<string, unknown>, f: FieldInfo): boolean {
  return f.name in values;
}

/** Component fields of compounds (BillingStreet…) are hidden when the compound itself is shown. */
function withoutShownComponents(fields: FieldInfo[], shown: Set<string>): FieldInfo[] {
  return fields.filter((f) => !(f.compoundFieldName && shown.has(f.compoundFieldName)));
}

export function sectionsFromLayout(layout: LayoutSummary, fields: FieldInfo[], values: Record<string, unknown>): FieldSection[] {
  const byName = new Map(fields.map((f) => [f.name, f]));
  const used = new Set<string>();
  const sections: FieldSection[] = [];
  layout.sections.forEach((sec, i) => {
    const list: FieldInfo[] = [];
    for (const name of sec.fields) {
      const f = byName.get(name);
      if (!f || used.has(name) || !readable(values, f)) continue;
      used.add(name);
      list.push(f);
    }
    if (list.length) sections.push({ id: `layout-${i}`, title: sec.heading || (i === 0 ? 'Details' : 'More details'), fields: list, collapsed: sec.collapsed });
  });
  // Components of shown compound fields count as shown.
  for (const f of fields) if (f.compoundFieldName && used.has(f.compoundFieldName)) used.add(f.name);
  const rest = withoutShownComponents(
    fields.filter((f) => !used.has(f.name) && readable(values, f)),
    used,
  ).sort((a, b) => a.label.localeCompare(b.label));
  if (rest.length) sections.push({ id: 'other', title: 'Other fields', fields: rest, collapsed: true });
  return sections;
}

const SYSTEM = new Set(['Id', 'CreatedById', 'CreatedDate', 'LastModifiedById', 'LastModifiedDate', 'SystemModstamp', 'LastViewedDate', 'LastReferencedDate', 'LastActivityDate', 'IsDeleted', 'MasterRecordId']);
const CONTACT_TYPES = new Set(['email', 'phone', 'url']);

/** Logical grouping from field metadata when no layout is available. */
export function sectionsFromMetadata(fields: FieldInfo[], values: Record<string, unknown>): FieldSection[] {
  const visible = fields.filter((f) => readable(values, f));
  const compounds = new Set(visible.filter((f) => f.type === 'address' || f.type === 'location').map((f) => f.name));
  const list = withoutShownComponents(visible, compounds);
  const groups: Record<string, FieldInfo[]> = { key: [], contact: [], address: [], related: [], standard: [], custom: [], text: [], system: [] };
  for (const f of list) {
    if (SYSTEM.has(f.name)) groups.system!.push(f);
    else if (f.nameField || ['OwnerId', 'RecordTypeId', 'Status', 'StageName', 'Type', 'Priority'].includes(f.name)) groups.key!.push(f);
    else if (f.type === 'address' || f.type === 'location') groups.address!.push(f);
    else if (CONTACT_TYPES.has(f.type)) groups.contact!.push(f);
    else if (f.type === 'reference') groups.related!.push(f);
    else if (f.type === 'textarea' && f.length > 255) groups.text!.push(f);
    else if (f.custom) groups.custom!.push(f);
    else groups.standard!.push(f);
  }
  const titles: Array<[keyof typeof groups, string, boolean]> = [
    ['key', 'Key information', false],
    ['contact', 'Contact details', false],
    ['address', 'Addresses', false],
    ['standard', 'Details', false],
    ['custom', 'Custom fields', false],
    ['related', 'Related records', false],
    ['text', 'Descriptions & notes', false],
    ['system', 'System information', true],
  ];
  return titles
    .filter(([k]) => groups[k]!.length)
    .map(([k, title, collapsed]) => ({
      id: `meta-${k}`,
      title,
      collapsed,
      fields: k === 'key' ? groups[k]! : [...groups[k]!].sort((a, b) => a.label.localeCompare(b.label)),
    }));
}

/** Filters sections by a search term over label, API name, and displayed value. */
export function filterSections(sections: FieldSection[], term: string, display: (f: FieldInfo) => string, hideEmpty: boolean): FieldSection[] {
  const t = term.trim().toLowerCase();
  return sections
    .map((s) => ({
      ...s,
      fields: s.fields.filter((f) => {
        const v = display(f);
        if (hideEmpty && !v) return false;
        return !t || `${f.label} ${f.name} ${v}`.toLowerCase().includes(t);
      }),
    }))
    .filter((s) => s.fields.length > 0);
}
