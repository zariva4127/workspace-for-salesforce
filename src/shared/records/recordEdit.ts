/**
 * Pure rules for creating and editing records: which fields a user may edit,
 * converting between form values and API values, client-side validation,
 * dependent picklists, minimal update payloads, server error mapping, and
 * merging edits after a concurrent change. No network or UI code here.
 */
import type { FieldInfo } from '../salesforce/metadata';
import type { SalesforceErrorBody } from '../api/errors';
import { isSalesforceId } from '../salesforce/ids';

export type Mode = 'create' | 'edit';
/** Form state: strings for text-like inputs, booleans for checkboxes. Multi-select picklists are ';'-joined. */
export type DraftValue = string | boolean;
export type Draft = Record<string, DraftValue>;

const TEXT_TYPES = new Set(['string', 'textarea', 'email', 'phone', 'url', 'encryptedstring', 'combobox']);
const NUMBER_TYPES = new Set(['int', 'double', 'currency', 'percent', 'long']);
const EDITABLE_TYPES = new Set([...TEXT_TYPES, ...NUMBER_TYPES, 'picklist', 'multipicklist', 'boolean', 'date', 'datetime', 'time', 'reference']);

export function isEditableType(type: string): boolean {
  return EDITABLE_TYPES.has(type);
}

export function isRequired(f: FieldInfo, mode: Mode): boolean {
  if (f.nillable || f.type === 'boolean') return false;
  return mode === 'create' ? !f.defaultedOnCreate : true;
}

/** Fields the connected user may set in this mode, required ones first. FLS is already applied by describe. */
export function formFields(fields: FieldInfo[], mode: Mode): FieldInfo[] {
  return fields
    .filter((f) => (mode === 'create' ? f.createable : f.updateable) && isEditableType(f.type) && f.name !== 'Id')
    .sort((a, b) => Number(isRequired(b, mode)) - Number(isRequired(a, mode)) || Number(b.nameField) - Number(a.nameField) || a.label.localeCompare(b.label));
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** API value → form value. Datetimes become local "YYYY-MM-DDTHH:mm" for <input type="datetime-local">. */
export function toDraftValue(f: FieldInfo, value: unknown): DraftValue {
  if (f.type === 'boolean') return value === true;
  if (value === null || value === undefined) return '';
  if (f.type === 'datetime' && typeof value === 'string') {
    const d = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isNaN(d.getTime())) return value;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (f.type === 'time' && typeof value === 'string') return value.slice(0, 5);
  return String(value);
}

/** Form value → API value. Empty text becomes null so Salesforce clears the field. */
export function toApiValue(f: FieldInfo, v: DraftValue): unknown {
  if (f.type === 'boolean') return v === true;
  const s = typeof v === 'string' ? v.trim() : '';
  if (s === '') return null;
  if (f.type === 'int' || f.type === 'long') return Number.parseInt(s, 10);
  if (NUMBER_TYPES.has(f.type)) return Number(s.replace(/,/g, ''));
  if (f.type === 'datetime') {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? s : d.toISOString();
  }
  if (f.type === 'time') return /^\d{2}:\d{2}$/.test(s) ? `${s}:00.000Z` : s;
  // Keep user whitespace inside long text, but trim single-line values.
  return f.type === 'textarea' && typeof v === 'string' ? v : s;
}

export function blankDraft(fields: FieldInfo[]): Draft {
  const d: Draft = {};
  for (const f of fields) d[f.name] = f.type === 'boolean' ? false : '';
  return d;
}

/** Initial values for a new record: picklist defaults plus any prefilled values (e.g. the parent lookup). */
export function createDraft(fields: FieldInfo[], prefill: Record<string, DraftValue> = {}): Draft {
  const d = blankDraft(fields);
  for (const f of fields) {
    if ((f.type === 'picklist' || f.type === 'multipicklist') && !f.controllerName) {
      const def = f.picklistValues.find((p) => p.active && p.defaultValue);
      if (def) d[f.name] = def.value;
    }
  }
  for (const [k, v] of Object.entries(prefill)) if (k in d) d[k] = v;
  return d;
}

export function editDraft(fields: FieldInfo[], values: Record<string, unknown>): Draft {
  const d: Draft = {};
  for (const f of fields) d[f.name] = toDraftValue(f, values[f.name]);
  return d;
}

// ---- Dependent picklists -----------------------------------------------------

/** Salesforce encodes dependent-picklist validity as a base64 bitmap indexed by controlling value position. */
export function validForIncludes(validFor: string | undefined, index: number): boolean {
  if (!validFor || index < 0) return false;
  let bytes: string;
  try {
    bytes = atob(validFor);
  } catch {
    return false;
  }
  const byte = bytes.charCodeAt(index >> 3);
  return Number.isFinite(byte) && (byte & (0x80 >> index % 8)) !== 0;
}

function controllerIndex(controller: FieldInfo, value: DraftValue): number {
  if (controller.type === 'boolean') return value === true ? 1 : 0;
  if (typeof value !== 'string' || value === '') return -1;
  return controller.picklistValues.findIndex((p) => p.value === value);
}

/** Active options of a picklist, narrowed by its controlling field's current value when dependent. */
export function picklistOptions(f: FieldInfo, all: FieldInfo[], draft: Draft): Array<{ value: string; label: string }> {
  const active = f.picklistValues.filter((p) => p.active);
  if (!f.dependentPicklist || !f.controllerName) return active;
  const controller = all.find((c) => c.name === f.controllerName);
  // If the controller isn't visible to the user, Salesforce still validates; don't hide options here.
  if (!controller) return active;
  const idx = controllerIndex(controller, draft[controller.name] ?? '');
  return active.filter((p) => validForIncludes(p.validFor, idx));
}

/**
 * After `changed` is edited, clears dependent picklist values that are no longer
 * valid (recursively, for chains). Returns the new draft and the labels cleared.
 */
export function applyDependencies(all: FieldInfo[], draft: Draft, changed: string): { draft: Draft; cleared: string[] } {
  let next = draft;
  const cleared: string[] = [];
  const queue = [changed];
  while (queue.length) {
    const name = queue.shift()!;
    for (const dep of all.filter((f) => f.controllerName === name && f.dependentPicklist)) {
      const cur = next[dep.name];
      if (typeof cur !== 'string' || cur === '') continue;
      const allowed = new Set(picklistOptions(dep, all, next).map((o) => o.value));
      const values = dep.type === 'multipicklist' ? cur.split(';') : [cur];
      const kept = values.filter((v) => allowed.has(v));
      if (kept.length !== values.length) {
        next = { ...next, [dep.name]: kept.join(';') };
        cleared.push(dep.label);
        queue.push(dep.name);
      }
    }
  }
  return { draft: next, cleared };
}

// ---- Validation ------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ValidationContext {
  mode: Mode;
  all: FieldInfo[];
  draft: Draft;
  /** Record ID key prefixes of objects, for lookup type checks: { Account: '001' }. */
  prefixes?: Record<string, string>;
}

export function validateField(f: FieldInfo, value: DraftValue, ctx: ValidationContext): string | undefined {
  if (f.type === 'boolean') return undefined;
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '') return isRequired(f, ctx.mode) ? `${f.label} is required.` : undefined;

  if (TEXT_TYPES.has(f.type) || f.type === 'textarea') {
    const len = f.type === 'textarea' ? String(value).length : s.length;
    if (f.length && len > f.length) return `Use ${f.length.toLocaleString()} characters or fewer (now ${len.toLocaleString()}).`;
  }
  if (f.type === 'email' && !EMAIL.test(s)) return 'Enter a valid email address, like name@example.com.';
  if (f.type === 'int' || f.type === 'long') {
    if (!/^-?\d+$/.test(s)) return 'Enter a whole number.';
    if (f.digits && s.replace('-', '').length > f.digits) return `Use at most ${f.digits} digits.`;
  }
  if (f.type === 'double' || f.type === 'currency' || f.type === 'percent') {
    const clean = s.replace(/,/g, '');
    if (!/^-?\d*\.?\d+$/.test(clean)) return 'Enter a number.';
    const intDigits = clean.replace('-', '').split('.')[0]!.replace(/^0+(?=\d)/, '').length;
    const maxInt = f.precision - f.scale;
    if (f.precision && intDigits > maxInt) return `Use at most ${maxInt} digits before the decimal point.`;
  }
  if (f.type === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))) return 'Enter a valid date.';
  if (f.type === 'datetime' && Number.isNaN(Date.parse(s))) return 'Enter a valid date and time.';
  if (f.type === 'time' && !/^\d{2}:\d{2}/.test(s)) return 'Enter a valid time.';
  if (f.type === 'picklist' || f.type === 'multipicklist') {
    const options = new Set(picklistOptions(f, ctx.all, ctx.draft).map((o) => o.value));
    const values = f.type === 'multipicklist' ? s.split(';').filter(Boolean) : [s];
    const bad = values.filter((v) => !options.has(v));
    if (bad.length && f.dependentPicklist && f.controllerName) {
      const c = ctx.all.find((x) => x.name === f.controllerName);
      return `“${bad[0]}” isn't available for the selected ${c?.label ?? f.controllerName}.`;
    }
    if (bad.length && f.restrictedPicklist) return `“${bad[0]}” isn't one of the allowed values.`;
  }
  if (f.type === 'reference') {
    if (!isSalesforceId(s)) return 'Pick a record, or paste a valid 15- or 18-character ID.';
    const prefixes = f.referenceTo.map((o) => ctx.prefixes?.[o]).filter((p): p is string => !!p);
    if (prefixes.length && prefixes.length === f.referenceTo.length && !prefixes.includes(s.slice(0, 3))) {
      return `That ID isn't a ${f.referenceTo.join(' or ')} record.`;
    }
  }
  return undefined;
}

export function validateDraft(fields: FieldInfo[], draft: Draft, ctx: Omit<ValidationContext, 'draft'>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const msg = validateField(f, draft[f.name] ?? '', { ...ctx, draft });
    if (msg) errors[f.name] = msg;
  }
  return errors;
}

// ---- Payloads, server errors, conflicts ----------------------------------------

function same(a: DraftValue | undefined, b: DraftValue | undefined): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return a === b;
}

/** Fields whose form value differs from the baseline, converted to API values. */
export function changedPayload(fields: FieldInfo[], draft: Draft, baseline: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (!same(draft[f.name], baseline[f.name])) out[f.name] = toApiValue(f, draft[f.name] ?? '');
  }
  return out;
}

export function changedFieldNames(fields: FieldInfo[], draft: Draft, baseline: Draft): string[] {
  return fields.filter((f) => !same(draft[f.name], baseline[f.name])).map((f) => f.name);
}

/**
 * Splits Salesforce DML errors into per-field messages (when Salesforce names the
 * field and it's on the form) and form-level messages.
 */
export function mapServerErrors(errors: SalesforceErrorBody[], fields: FieldInfo[]): { fieldErrors: Record<string, string>; formErrors: string[] } {
  const byLower = new Map(fields.map((f) => [f.name.toLowerCase(), f.name]));
  const fieldErrors: Record<string, string> = {};
  const formErrors: string[] = [];
  for (const e of errors) {
    const msg = e.message ?? e.errorCode ?? 'Unknown error';
    const onForm = (e.fields ?? []).map((n) => byLower.get(n.toLowerCase())).filter((n): n is string => !!n);
    if (onForm.length) for (const n of onForm) fieldErrors[n] = fieldErrors[n] ? `${fieldErrors[n]} ${msg}` : msg;
    else formErrors.push(msg);
  }
  return { fieldErrors, formErrors };
}

/**
 * After a concurrent change: start from the latest saved values and re-apply the
 * user's own edits. Fields both people changed are reported as conflicts so the
 * user can review them before saving again.
 */
export function mergeAfterReload(fields: FieldInfo[], original: Draft, latest: Draft, draft: Draft): { draft: Draft; conflicts: string[]; theirChanges: string[] } {
  const next: Draft = { ...latest };
  const conflicts: string[] = [];
  const theirChanges: string[] = [];
  for (const f of fields) {
    const mine = !same(draft[f.name], original[f.name]);
    const theirs = !same(latest[f.name], original[f.name]);
    if (mine) next[f.name] = draft[f.name]!;
    if (theirs) theirChanges.push(f.label);
    if (mine && theirs && !same(draft[f.name], latest[f.name])) conflicts.push(f.label);
  }
  return { draft: next, conflicts, theirChanges };
}

// ---- Which actions to offer ----------------------------------------------------

export interface ActionState {
  allowed: boolean;
  /** Plain-language reason when not allowed. */
  reason?: string;
}

export interface RecordActions {
  edit: ActionState;
  delete: ActionState;
  create: ActionState;
}

/**
 * Combines the object's describe (object permissions + field-level security for
 * the connected user) with UserRecordAccess for this record (sharing). When the
 * record access check couldn't run, actions stay available and Salesforce
 * enforces access on save.
 */
export function recordActions(
  object: { label: string; createable: boolean; updateable: boolean; deletable: boolean; fields: FieldInfo[] },
  access: { edit: boolean; delete: boolean } | undefined,
  opts: { changesEnabled: boolean },
): RecordActions {
  const off: ActionState = { allowed: false, reason: 'Record changes are turned off in Settings.' };
  if (!opts.changesEnabled) return { edit: off, delete: off, create: off };
  const plural = object.label;
  const edit: ActionState = !object.updateable
    ? { allowed: false, reason: `Your profile or permission sets don't allow editing ${plural} records.` }
    : access && !access.edit
      ? { allowed: false, reason: "This record isn't shared with you for editing (or it's locked)." }
      : formFields(object.fields, 'edit').length === 0
        ? { allowed: false, reason: 'None of this record’s fields are editable for you.' }
        : { allowed: true };
  const del: ActionState = !object.deletable
    ? { allowed: false, reason: `Your profile or permission sets don't allow deleting ${plural} records.` }
    : access && !access.delete
      ? { allowed: false, reason: 'Only the owner, someone above them in the role hierarchy, or an admin can delete this record.' }
      : { allowed: true };
  const create: ActionState = object.createable ? { allowed: true } : { allowed: false, reason: `Your profile or permission sets don't allow creating ${plural} records.` };
  return { edit, delete: del, create };
}
