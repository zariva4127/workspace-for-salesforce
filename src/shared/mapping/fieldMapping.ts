/**
 * Flags obvious problems when mapping values from one field to another
 * (data migrations, integrations, flow assignments). Rule-based and conservative:
 * it reports clear mismatches, not every theoretical edge case.
 */
import type { FieldInfo } from '../salesforce/metadata';

export type Severity = 'error' | 'warning' | 'info';

export interface MappingIssue {
  severity: Severity;
  message: string;
}

export type MappingField = Pick<
  FieldInfo,
  | 'name'
  | 'type'
  | 'length'
  | 'precision'
  | 'scale'
  | 'digits'
  | 'referenceTo'
  | 'picklistValues'
  | 'restrictedPicklist'
  | 'createable'
  | 'updateable'
  | 'calculated'
  | 'autoNumber'
  | 'nillable'
  | 'defaultedOnCreate'
>;

const TEXT = new Set(['string', 'textarea', 'email', 'phone', 'url', 'encryptedstring', 'combobox']);
const NUMBER = new Set(['int', 'double', 'currency', 'percent', 'long']);
const PICK = new Set(['picklist', 'multipicklist']);
const COMPOUND = new Set(['address', 'location']);

function family(type: string): string {
  if (TEXT.has(type)) return 'text';
  if (NUMBER.has(type)) return 'number';
  if (PICK.has(type)) return type;
  if (type === 'reference' || type === 'id') return 'reference';
  return type;
}

/** Maximum text length produced by a source field, if bounded. */
function textLength(f: MappingField): number | undefined {
  if (TEXT.has(f.type) || f.type === 'picklist' || f.type === 'multipicklist') return f.length || undefined;
  if (f.type === 'reference' || f.type === 'id') return 18;
  if (f.type === 'boolean') return 5;
  if (NUMBER.has(f.type)) return f.precision ? f.precision + 2 : f.digits || undefined;
  if (f.type === 'date') return 10;
  if (f.type === 'datetime') return 28;
  return undefined;
}

export function checkMapping(source: MappingField, target: MappingField, opts: { isInsert?: boolean } = { isInsert: true }): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const s = family(source.type);
  const t = family(target.type);
  const insert = opts.isInsert !== false;

  if (target.calculated || target.autoNumber) {
    issues.push({ severity: 'error', message: `${target.name} is a ${target.autoNumber ? 'auto-number' : 'formula/roll-up'} field and cannot be written.` });
    return issues;
  }
  if (insert ? !target.createable : !target.updateable) {
    issues.push({ severity: 'error', message: `${target.name} is not ${insert ? 'createable' : 'updateable'} (by definition or for your user).` });
  }
  if (COMPOUND.has(source.type) || COMPOUND.has(target.type)) {
    issues.push({ severity: 'warning', message: 'Compound fields (address/location) must be mapped through their component fields (Street, City, Latitude…).' });
    return issues;
  }
  if (target.type === 'base64' || source.type === 'base64') {
    issues.push({ severity: 'warning', message: 'Binary (base64) fields need special handling and cannot be mapped to other types.' });
    return issues;
  }

  if (source.type === target.type && !['text', 'number', 'picklist', 'multipicklist', 'reference'].includes(s)) {
    // Same simple type (boolean, date, …): only the required-field check below applies.
  } else if (t === 'text') {
    const len = textLength(source);
    if (len && target.length && len > target.length) {
      issues.push({ severity: 'warning', message: `Source values can be up to ${len} characters; ${target.name} allows ${target.length}. Values may be truncated or rejected.` });
    }
    if (s !== 'text' && s !== 'picklist') issues.push({ severity: 'info', message: `${source.type} values will be converted to text.` });
    if (target.type === 'email' && source.type !== 'email') issues.push({ severity: 'warning', message: 'Target is an Email field; values must be valid email addresses.' });
  } else if (t === 'number') {
    if (s === 'number') {
      const sInt = source.precision - source.scale;
      const tInt = target.precision - target.scale;
      if (source.precision && target.precision && sInt > tInt) {
        issues.push({ severity: 'warning', message: `Source allows ${sInt} integer digits; target allows ${tInt}. Large values will be rejected.` });
      }
      if (source.scale > target.scale) {
        issues.push({ severity: 'warning', message: `Source has ${source.scale} decimal places; target keeps ${target.scale}. Values will be rounded.` });
      }
      if ((source.type === 'currency') !== (target.type === 'currency')) {
        issues.push({ severity: 'info', message: 'Mixing currency and non-currency numbers: check multi-currency conversion.' });
      }
    } else if (s === 'text') {
      issues.push({ severity: 'warning', message: 'Text → number requires every value to be numeric.' });
    } else {
      issues.push({ severity: 'error', message: `${source.type} cannot be converted to a number.` });
    }
  } else if (t === 'picklist' || t === 'multipicklist') {
    if (s === 'picklist' || s === 'multipicklist') {
      if (s === 'multipicklist' && t === 'picklist') {
        issues.push({ severity: 'warning', message: 'Multi-select → single-select: records with several values cannot be mapped directly.' });
      }
      const targetValues = new Set(target.picklistValues.filter((p) => p.active).map((p) => p.value));
      const missing = source.picklistValues.filter((p) => p.active && !targetValues.has(p.value)).map((p) => p.value);
      if (missing.length) {
        issues.push({
          severity: target.restrictedPicklist ? 'error' : 'warning',
          message: `${missing.length} source value(s) not in target${target.restrictedPicklist ? ' (restricted picklist — saves will fail)' : ''}: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`,
        });
      }
    } else if (s === 'text') {
      issues.push({
        severity: target.restrictedPicklist ? 'warning' : 'info',
        message: `Free text → picklist: values must match picklist API values${target.restrictedPicklist ? ' exactly (restricted)' : ''}.`,
      });
    } else if (source.type === 'boolean') {
      issues.push({ severity: 'warning', message: 'Checkbox → picklist: target needs "true"/"false" values or a translation.' });
    } else {
      issues.push({ severity: 'error', message: `${source.type} cannot be mapped to a picklist without a translation.` });
    }
  } else if (t === 'reference') {
    if (s !== 'reference') {
      issues.push({ severity: s === 'text' ? 'warning' : 'error', message: s === 'text' ? 'Text → lookup: values must be valid record IDs (or use an external ID upsert).' : `${source.type} cannot be mapped to a lookup.` });
    } else {
      const allowed = new Set(target.referenceTo);
      const bad = source.referenceTo.filter((r) => !allowed.has(r));
      if (bad.length) issues.push({ severity: 'error', message: `Source can point to ${bad.join(', ')}, but ${target.name} only accepts ${target.referenceTo.join(', ') || 'no objects'}.` });
    }
  } else if (target.type === 'boolean') {
    if (source.type !== 'boolean') issues.push({ severity: s === 'text' || s === 'picklist' ? 'warning' : 'error', message: `${source.type} → checkbox requires true/false values.` });
  } else if (target.type === 'date' || target.type === 'datetime' || target.type === 'time') {
    if (source.type === 'datetime' && target.type === 'date') issues.push({ severity: 'warning', message: 'Date/time → date drops the time and may shift the day across time zones.' });
    else if (source.type === 'date' && target.type === 'datetime') issues.push({ severity: 'info', message: 'Date → date/time sets the time to midnight GMT.' });
    else if (s === 'text') issues.push({ severity: 'warning', message: `Text → ${target.type} requires ISO-8601 formatted values.` });
    else if (source.type !== target.type) issues.push({ severity: 'error', message: `${source.type} cannot be converted to ${target.type}.` });
  } else if (source.type !== target.type) {
    issues.push({ severity: 'error', message: `${source.type} → ${target.type} is not a supported conversion.` });
  }

  if (source.nillable && !target.nillable && target.type !== 'boolean' && !target.defaultedOnCreate) {
    issues.push({ severity: 'warning', message: `${target.name} is required but the source can be blank.` });
  }
  return issues;
}

/** Target fields that must be populated on insert but are not mapped. */
export function unmappedRequired(targetFields: MappingField[], mappedTargets: Set<string>): string[] {
  return targetFields
    .filter((f) => f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean' && !mappedTargets.has(f.name))
    .map((f) => f.name);
}

/** Suggests a target for each source field by API name, then label-like name. */
export function suggestMapping(sourceFields: MappingField[], targetFields: MappingField[]): Map<string, string> {
  const norm = (n: string) => n.toLowerCase().replace(/__c$/, '').replace(/[^a-z0-9]/g, '');
  const byName = new Map(targetFields.map((f) => [f.name.toLowerCase(), f.name]));
  const byNorm = new Map(targetFields.map((f) => [norm(f.name), f.name]));
  const result = new Map<string, string>();
  for (const s of sourceFields) {
    const t = byName.get(s.name.toLowerCase()) ?? byNorm.get(norm(s.name));
    if (t) result.set(s.name, t);
  }
  return result;
}

export function worstSeverity(issues: MappingIssue[]): Severity | 'ok' {
  if (issues.some((i) => i.severity === 'error')) return 'error';
  if (issues.some((i) => i.severity === 'warning')) return 'warning';
  if (issues.length) return 'info';
  return 'ok';
}
