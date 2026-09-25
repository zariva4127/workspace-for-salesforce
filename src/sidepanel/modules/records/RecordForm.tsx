/**
 * Create / edit a record in a modal.
 *
 * - Only fields the user may set are shown (describe applies object permissions
 *   and field-level security); required fields come first and are marked.
 * - Values are validated before saving; Salesforce errors are shown next to the
 *   field they belong to (or at the top) and the user's edits are kept.
 * - Edits use If-Unmodified-Since, so a concurrent change is detected (412) and
 *   the user can merge the latest version or overwrite it.
 * - The draft is kept in this window's sessionStorage, so an expired session
 *   (which unmounts the form) doesn't lose work.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { Modal } from '../../components/Modal';
import { SearchInput } from '../../components/SearchInput';
import { Alert } from '../../components/States';
import { useObjects } from '../../components/Pickers';
import { LookupInput } from './LookupInput';
import {
  applyDependencies,
  blankDraft,
  changedFieldNames,
  changedPayload,
  createDraft,
  editDraft,
  formFields,
  isRequired,
  mapServerErrors,
  mergeAfterReload,
  picklistOptions,
  validateDraft,
  type Draft,
  type DraftValue,
  type Mode,
} from '../../../shared/records/recordEdit';
import type { FieldInfo, ObjectDescribe } from '../../../shared/salesforce/metadata';
import { SalesforceApiError, explainError } from '../../../shared/api/errors';
import { effectiveEnvironment } from '../../../shared/org/profiles';

export interface RecordFormProps {
  mode: Mode;
  describe: ObjectDescribe;
  /** Edit mode: the record's current values and lookup display names. */
  recordId?: string;
  values?: Record<string, unknown>;
  lookupNames?: Record<string, string>;
  /** Create mode: values to prefill (e.g. the parent lookup of a related record). */
  prefill?: Record<string, DraftValue>;
  onClose: () => void;
  onSaved: (result: { id: string; name: string }) => void;
}

type Filter = 'all' | 'required' | 'changed' | 'errors';

interface StoredDraft {
  draft: Draft;
  names: Record<string, string>;
  recordTypeId: string;
  savedAt: number;
}

function draftKey(orgKey: string, mode: Mode, target: string): string {
  return `sfw-draft:${orgKey}:${mode}:${target}`;
}

function readStored(key: string): StoredDraft | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as StoredDraft) : undefined;
  } catch {
    return undefined;
  }
}

/** True when there's a saved, unsaved draft for this record (e.g. after the session expired). */
export function hasStoredDraft(orgKey: string, mode: Mode, target: string): boolean {
  return !!readStored(draftKey(orgKey, mode, target));
}

export function discardStoredDraft(orgKey: string, mode: Mode, target: string): void {
  try {
    sessionStorage.removeItem(draftKey(orgKey, mode, target));
  } catch {
    // Storage unavailable; nothing to discard.
  }
}

function FieldControl({
  f,
  all,
  draft,
  value,
  name,
  mode,
  error,
  changed,
  onValue,
}: {
  f: FieldInfo;
  all: FieldInfo[];
  draft: Draft;
  value: DraftValue;
  name?: string;
  mode: Mode;
  error?: string;
  changed: boolean;
  onValue: (v: DraftValue, name?: string) => void;
}) {
  const id = `rf-${f.name}`;
  const req = isRequired(f, mode);
  const describedBy = [error ? `${id}-err` : '', f.inlineHelpText ? `${id}-help` : ''].filter(Boolean).join(' ') || undefined;
  const common = { id, 'aria-invalid': !!error, 'aria-describedby': describedBy, 'aria-required': req } as const;
  const str = typeof value === 'string' ? value : '';

  let control;
  if (f.type === 'boolean') {
    control = (
      <label class="check">
        <input type="checkbox" {...common} checked={value === true} onChange={(e) => onValue(e.currentTarget.checked)} /> {value === true ? 'Yes' : 'No'}
      </label>
    );
  } else if (f.type === 'picklist') {
    const options = picklistOptions(f, all, draft);
    const current = str && !options.some((o) => o.value === str) ? str : undefined;
    const controller = f.controllerName ? all.find((c) => c.name === f.controllerName) : undefined;
    control = (
      <select {...common} value={str} onChange={(e) => onValue(e.currentTarget.value)} disabled={!!controller && options.length === 0 && !current}>
        <option value="">{controller && options.length === 0 ? `Choose ${controller.label} first` : '— None —'}</option>
        {current && <option value={current}>{current} (not available)</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  } else if (f.type === 'multipicklist') {
    const selected = new Set(str.split(';').filter(Boolean));
    const options = picklistOptions(f, all, draft);
    control = (
      <fieldset class="multi" aria-describedby={describedBy} aria-invalid={!!error}>
        <legend class="visually-hidden">{f.label}</legend>
        {options.length === 0 && <span class="subtle">No values available.</span>}
        {options.map((o) => (
          <label key={o.value} class="check">
            <input
              type="checkbox"
              checked={selected.has(o.value)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.currentTarget.checked) next.add(o.value);
                else next.delete(o.value);
                onValue(options.map((x) => x.value).filter((v) => next.has(v)).join(';'));
              }}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
    );
  } else if (f.type === 'reference') {
    control = <LookupInput id={id} field={f} value={str} {...(name ? { name } : {})} onChange={(v, n) => onValue(v, n)} invalid={!!error} {...(describedBy ? { describedBy } : {})} required={req} />;
  } else if (f.type === 'textarea') {
    control = <textarea {...common} rows={Math.min(8, Math.max(3, Math.ceil(str.length / 80)))} value={str} onInput={(e) => onValue(e.currentTarget.value)} />;
  } else {
    const inputType =
      f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : f.type === 'time' ? 'time' : f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : f.type === 'url' ? 'url' : 'text';
    const numeric = ['int', 'double', 'currency', 'percent', 'long'].includes(f.type);
    control = (
      <div class={numeric && (f.type === 'currency' || f.type === 'percent') ? 'affix' : undefined}>
        <input
          {...common}
          type={inputType}
          inputMode={numeric ? (f.type === 'int' ? 'numeric' : 'decimal') : undefined}
          value={str}
          maxLength={f.length && !numeric && inputType === 'text' ? f.length : undefined}
          list={f.type === 'combobox' ? `${id}-list` : undefined}
          onInput={(e) => onValue(e.currentTarget.value)}
        />
        {f.type === 'percent' && <span aria-hidden="true">%</span>}
        {f.type === 'combobox' && (
          <datalist id={`${id}-list`}>
            {f.picklistValues.filter((p) => p.active).map((p) => (
              <option key={p.value} value={p.value} />
            ))}
          </datalist>
        )}
      </div>
    );
  }

  return (
    <div class={`field form-field ${error ? 'has-error' : ''} ${f.type === 'textarea' || f.type === 'multipicklist' ? 'span-2' : ''}`}>
      <div class="row nowrap">
        {f.type === 'multipicklist' || f.type === 'boolean' ? (
          <span class="label-like grow">
            {f.label}
            {req && <abbr title="required"> *</abbr>}
          </span>
        ) : (
          <label for={id} class="grow">
            {f.label}
            {req && <abbr title="required"> *</abbr>}
          </label>
        )}
        {changed && <span class="pill info">Changed</span>}
      </div>
      {control}
      {error && (
        <span id={`${id}-err`} class="field-error" role="alert">
          {error}
        </span>
      )}
      {f.inlineHelpText && (
        <span id={`${id}-help`} class="hint">
          {f.inlineHelpText}
        </span>
      )}
    </div>
  );
}

/** A readable name for a just-saved record, from what the user entered. */
function displayNameFor(all: FieldInfo[], fields: FieldInfo[], draft: Draft): string | undefined {
  const text = (n: string) => (typeof draft[n] === 'string' ? (draft[n] as string).trim() : '');
  const nameField = all.find((f) => f.nameField)?.name;
  if (nameField && text(nameField)) return text(nameField);
  // Compound names (Contact, Lead, Person Account) aren't set directly.
  const person = [text('FirstName'), text('LastName')].filter(Boolean).join(' ');
  if (person) return person;
  const firstText = fields.find((f) => f.type === 'string' && text(f.name));
  return firstText ? text(firstText.name) : undefined;
}

export function RecordForm({ mode, describe, recordId, values, lookupNames, prefill, onClose, onSaved }: RecordFormProps) {
  const ws = useWorkspace();
  const objects = useObjects();
  const orgKey = ws.org!.key;
  const storageKey = draftKey(orgKey, mode, recordId ?? describe.name);
  const all = describe.fields;

  const recordTypeField = all.find((f) => f.name === 'RecordTypeId');
  const recordTypes = describe.recordTypes.filter((r) => r.available && !r.master);
  const canPickRecordType = !!recordTypeField && (mode === 'create' ? recordTypeField.createable : recordTypeField.updateable) && recordTypes.length > 1;
  const fields = useMemo(() => formFields(all, mode).filter((f) => f.name !== 'RecordTypeId'), [all, mode]);

  const initialRecordType = (values?.RecordTypeId as string | undefined) ?? recordTypes.find((r) => r.defaultForUser)?.id ?? '';
  const baseline = useMemo(() => (mode === 'edit' ? editDraft(fields, values ?? {}) : createDraft(fields, prefill)), [fields]);
  const stored = useMemo(() => readStored(storageKey), []);

  const [original, setOriginal] = useState<Draft>(baseline);
  const [draft, setDraft] = useState<Draft>(stored?.draft ?? baseline);
  const [names, setNames] = useState<Record<string, string>>(stored?.names ?? lookupNames ?? {});
  const [recordTypeId, setRecordTypeId] = useState(stored?.recordTypeId ?? initialRecordType);
  const [lastModified, setLastModified] = useState(values?.LastModifiedDate as string | undefined);
  const [restored, setRestored] = useState(!!stored);
  const [showErrors, setShowErrors] = useState(false);
  const [serverFieldErrors, setServerFieldErrors] = useState<Record<string, string>>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string>();
  const [conflict, setConflict] = useState<{ theirChanges?: string[]; conflicts?: string[]; merged?: boolean } | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>(mode === 'create' ? 'all' : 'all');
  const bodyRef = useRef<HTMLDivElement>(null);

  // Keep the draft in this window so an expired session or reload doesn't lose it.
  useEffect(() => {
    try {
      const dirtyNow = changedFieldNames(fields, draft, original).length > 0 || recordTypeId !== initialRecordType;
      if (dirtyNow) sessionStorage.setItem(storageKey, JSON.stringify({ draft, names, recordTypeId, savedAt: Date.now() } satisfies StoredDraft));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // Storage unavailable; the form still works, drafts just aren't kept.
    }
  }, [draft, names, recordTypeId]);

  const prefixes = useMemo(() => Object.fromEntries((objects.data?.value ?? []).filter((o) => o.keyPrefix).map((o) => [o.name, o.keyPrefix!])), [objects.data]);
  const clientErrors = useMemo(() => validateDraft(fields, draft, { mode, all, prefixes }), [fields, draft, prefixes]);
  const errorFor = (name: string) => serverFieldErrors[name] ?? (showErrors ? clientErrors[name] : undefined);
  const changed = changedFieldNames(fields, draft, original);
  const errorNames = fields.filter((f) => errorFor(f.name)).map((f) => f.name);
  const dirty = changed.length > 0 || recordTypeId !== initialRecordType;

  const setValue = (f: FieldInfo, v: DraftValue, name?: string) => {
    setServerFieldErrors((e) => {
      if (!e[f.name]) return e;
      const { [f.name]: _removed, ...rest } = e;
      return rest;
    });
    if (f.type === 'reference') setNames((n) => ({ ...n, [f.name]: name ?? '' }));
    setDraft((prev) => {
      const next = { ...prev, [f.name]: v };
      const { draft: withDeps, cleared } = applyDependencies(all, next, f.name);
      setNotice(cleared.length ? `Cleared ${cleared.join(', ')} because it doesn't apply to the new ${f.label}.` : undefined);
      return withDeps;
    });
  };

  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    return fields.filter((f) => {
      if (t && !`${f.label} ${f.name}`.toLowerCase().includes(t)) return false;
      if (filter === 'required') return isRequired(f, mode);
      if (filter === 'changed') return changed.includes(f.name);
      if (filter === 'errors') return !!errorFor(f.name);
      return true;
    });
  }, [fields, q, filter, draft, original, serverFieldErrors, showErrors, clientErrors]);

  /** Focuses the first invalid control as it appears on screen (required fields are listed first). */
  const focusFirstError = (names: string[]) => {
    setTimeout(() => {
      const els = names.map((n) => bodyRef.current?.querySelector<HTMLElement>(`#rf-${n}`)).filter((e): e is HTMLElement => !!e);
      const first = els.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
      first?.focus();
      first?.scrollIntoView({ block: 'center' });
    });
  };

  const reloadLatest = async () => {
    if (!ws.client || !recordId) return;
    try {
      const latestRaw = await ws.client.getRecord<Record<string, unknown>>(describe.name, recordId);
      const latest = editDraft(fields, latestRaw);
      const merged = mergeAfterReload(fields, original, latest, draft);
      setOriginal(latest);
      setDraft(merged.draft);
      setLastModified(latestRaw.LastModifiedDate as string | undefined);
      setConflict({ theirChanges: merged.theirChanges, conflicts: merged.conflicts, merged: true });
      setOverwrite(false);
    } catch (e) {
      const ex = explainError(e);
      setFormErrors([ex.kind === 'notFound' ? 'This record was deleted while you were editing it. Copy anything you need before closing.' : `${ex.title}: ${ex.detail}`]);
    }
  };

  const save = async (): Promise<boolean | void> => {
    setShowErrors(true);
    setFormErrors([]);
    const errs = Object.keys(clientErrors);
    if (errs.length) {
      setFilter('all');
      setQ('');
      setFormErrors([`Fix ${errs.length} field${errs.length === 1 ? '' : 's'} before saving.`]);
      focusFirstError(fields.filter((f) => clientErrors[f.name]).map((f) => f.name));
      return false;
    }
    if (!ws.client) {
      setFormErrors(['Not connected. Your changes are kept in this window — reconnect, then save again.']);
      return false;
    }
    const payload: Record<string, unknown> = changedPayload(fields, draft, mode === 'edit' ? original : blankDraft(fields));
    if (canPickRecordType && recordTypeId && recordTypeId !== ((values?.RecordTypeId as string | undefined) ?? '')) payload.RecordTypeId = recordTypeId;
    if (mode === 'edit' && Object.keys(payload).length === 0) {
      discardStoredDraft(orgKey, mode, recordId ?? describe.name);
      return true;
    }
    try {
      let id = recordId ?? '';
      if (mode === 'create') {
        id = (await ws.client.createRecord(describe.name, payload)).id;
      } else {
        await ws.client.updateRecord(describe.name, recordId!, payload, overwrite || !lastModified ? {} : { ifUnmodifiedSince: lastModified });
      }
      discardStoredDraft(orgKey, mode, recordId ?? describe.name);
      onSaved({ id, name: displayNameFor(all, fields, draft) ?? (mode === 'edit' ? '' : 'the new record') });
      return true;
    } catch (e) {
      const ex = explainError(e);
      if (ex.kind === 'conflict') {
        setConflict({});
        return false;
      }
      if (e instanceof SalesforceApiError && e.errors.length) {
        const mapped = mapServerErrors(e.errors, fields);
        setServerFieldErrors(mapped.fieldErrors);
        const n = Object.keys(mapped.fieldErrors).length;
        const lead = ex.kind === 'validation' ? "Salesforce didn't save the record." : ex.title;
        setFormErrors([...(n ? [`${lead} Check the highlighted field${n === 1 ? '' : 's'}.`] : [lead]), ...mapped.formErrors]);
        if (n) focusFirstError(Object.keys(mapped.fieldErrors));
        return false;
      }
      if (ex.kind === 'auth') setFormErrors(['Your Salesforce session ended. Your changes are kept in this window — reconnect, then open this form again to finish saving.']);
      else if (ex.kind === 'notFound') setFormErrors(['This record no longer exists (it may have been deleted). Copy anything you need before closing.']);
      else setFormErrors([`${ex.title}: ${ex.detail}${ex.action ? ` ${ex.action}` : ''}`]);
      return false;
    }
  };

  // Salesforce's describe has no section info, so the meaningful split is required vs optional.
  const groups = useMemo(() => {
    const req = visible.filter((f) => isRequired(f, mode));
    const opt = visible.filter((f) => !isRequired(f, mode));
    return [
      ...(req.length ? [{ title: 'Required', fields: req }] : []),
      ...(opt.length ? [{ title: req.length ? 'Other fields' : 'Fields', fields: opt }] : []),
    ];
  }, [visible, mode]);
  const needAttention = Object.keys(clientErrors).length + Object.keys(serverFieldErrors).filter((n) => !clientErrors[n]).length;

  const prod = effectiveEnvironment(ws.org!) === 'production';
  const required = fields.filter((f) => isRequired(f, mode));
  const filters: Array<[Filter, string, number]> = [
    ['all', 'All', fields.length],
    ['required', 'Required', required.length],
    ['changed', 'Changed', changed.length],
    ['errors', 'Needs attention', errorNames.length],
  ];

  return (
    <Modal
      open
      wide
      title={mode === 'create' ? `New ${describe.label}` : `Edit ${describe.label}`}
      saveLabel={mode === 'create' ? `Create ${describe.label}` : 'Save changes'}
      dirty={dirty}
      onSave={save}
      onClose={() => {
        discardStoredDraft(orgKey, mode, recordId ?? describe.name);
        onClose();
      }}
      footerNote={
        <span class="form-summary" role="status" aria-live="polite">
          <span>{mode === 'edit' ? (changed.length ? `${changed.length} changed` : 'No changes yet') : `${required.length} required`}</span>
          <span class={`pill ${needAttention ? 'warning' : 'ok'}`}>{needAttention ? `${needAttention} missing or invalid` : 'Ready to save'}</span>
        </span>
      }
    >
      <div class="stack" ref={bodyRef}>
        {prod && <Alert kind="warning">You're {mode === 'create' ? 'creating a record' : 'editing a record'} in a production org.</Alert>}
        {restored && (
          <Alert kind="info" title="Restored your unsaved changes">
            <div class="row">
              <span class="grow">They were kept when this form closed unexpectedly (for example, when your session ended).</span>
              <button
                type="button"
                class="btn small"
                onClick={() => {
                  setDraft(original);
                  setRecordTypeId(initialRecordType);
                  setRestored(false);
                }}
              >
                Start over
              </button>
            </div>
          </Alert>
        )}
        {conflict && (
          <div class="alert warning" role="alert">
            {conflict.merged ? (
              <>
                <strong>Loaded the latest version</strong>
                {conflict.theirChanges?.length ? <div>They changed: {conflict.theirChanges.join(', ')}.</div> : <div>No field you can edit was changed.</div>}
                {conflict.conflicts?.length ? (
                  <div>
                    You both changed <strong>{conflict.conflicts.join(', ')}</strong> — your value is kept. Review it, then save.
                  </div>
                ) : (
                  <div>Your changes are kept on top. Save again when you're ready.</div>
                )}
              </>
            ) : (
              <>
                <strong>Someone changed this record after you opened it</strong>
                <div>Saving now could overwrite their changes.</div>
                <div class="row" style={{ marginTop: 6 }}>
                  <button type="button" class="btn small primary" onClick={() => void reloadLatest()}>
                    Load their changes and keep mine
                  </button>
                  <button
                    type="button"
                    class="btn small danger"
                    onClick={() => {
                      setOverwrite(true);
                      setConflict(null);
                      setNotice('Save again to overwrite their changes with yours.');
                    }}
                  >
                    Overwrite with mine
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {formErrors.length > 0 && (
          <div class="alert error" role="alert">
            {formErrors.map((m, i) => (i === 0 ? <strong key={i}>{m}</strong> : <div key={i}>{m}</div>))}
          </div>
        )}
        {notice && (
          <div class="alert info" role="status">
            {notice}
          </div>
        )}
        {canPickRecordType && (
          <div class="field">
            <label for="rf-RecordTypeId">Record type</label>
            <select id="rf-RecordTypeId" value={recordTypeId} onChange={(e) => setRecordTypeId(e.currentTarget.value)}>
              {recordTypes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <span class="hint">Some picklist values depend on the record type; Salesforce checks them when you save.</span>
          </div>
        )}
        <div class="form-toolbar">
          <SearchInput placeholder="Find a field" label="Find a field" value={q} onValue={setQ} />
          <div class="subnav pills" role="radiogroup" aria-label="Show fields">
            {filters.map(([k, label, n]) => (
              <button key={k} type="button" role="radio" aria-checked={filter === k} onClick={() => setFilter(k)} disabled={k !== 'all' && n === 0 && filter !== k}>
                {label} ({n})
              </button>
            ))}
          </div>
        </div>
        {fields.length === 0 ? (
          <p class="muted">You can't set any fields on this object.</p>
        ) : visible.length === 0 ? (
          <p class="muted">No fields match. {q && <button type="button" class="link-button" onClick={() => setQ('')}>Clear the search</button>}</p>
        ) : (
          <>
            {groups.map((g) => (
              <section key={g.title} class="stack" aria-label={g.title}>
                {groups.length > 1 && (
                  <h3 class="form-group-title">
                    {g.title} ({g.fields.length})
                  </h3>
                )}
                <div class="form-grid">
                  {g.fields.map((f) => (
                    <FieldControl
                      key={f.name}
                      f={f}
                      all={all}
                      draft={draft}
                      value={draft[f.name] ?? ''}
                      {...(names[f.name] ? { name: names[f.name] } : {})}
                      mode={mode}
                      {...(errorFor(f.name) ? { error: errorFor(f.name)! } : {})}
                      changed={mode === 'edit' && changed.includes(f.name)}
                      onValue={(v, n) => setValue(f, v, n)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
        <p class="subtle">Only fields you're allowed to {mode === 'create' ? 'set' : 'edit'} are shown. Salesforce applies validation rules, duplicate rules, and automation when you save.</p>
      </div>
    </Modal>
  );
}
