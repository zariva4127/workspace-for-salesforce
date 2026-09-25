/** Object and field pickers backed by the per-org metadata cache. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useWorkspace } from '../state/workspace';
import { Icon } from './Icon';
import { useAsync } from '../hooks/useAsync';
import { usePopupStyle } from '../hooks/usePopupStyle';
import { objectLabel, rankObjects, type FieldInfo, type ObjectDescribe, type ObjectSummary } from '../../shared/salesforce/metadata';

export function useObjects(force = 0) {
  const ws = useWorkspace();
  return useAsync<{ value: ObjectSummary[]; fetchedAt: number; fromCache: boolean }>(
    ws.metadata ? (signal) => ws.metadata!.objects({ signal, force: force > 0 }) : null,
    [ws.metadata, force],
  );
}

export function useDescribe(objectApiName: string | undefined, force = 0) {
  const ws = useWorkspace();
  return useAsync<{ value: ObjectDescribe; fetchedAt: number; fromCache: boolean }>(
    ws.metadata && objectApiName ? (signal) => ws.metadata!.describe(objectApiName, { signal, force: force > 0 }) : null,
    [ws.metadata, objectApiName, force],
  );
}

/** Accessible, bounded combobox. Avoids Chrome's oversized native datalist popup. */
export function ObjectPicker({ id, label, value, onChange, objects }: { id: string; label: string; value: string; onChange: (v: string) => void; objects: ObjectSummary[] | undefined }) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [showSystem, setShowSystem] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const popup = usePopupStyle(open, anchor);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  // While an object is selected, the input shows its API name; list everything until the user types.
  const q = draft === value ? '' : draft;
  const ranked = useMemo(() => rankObjects(objects ?? [], q, { includeSystem: showSystem }), [objects, q, showSystem]);
  const matches = ranked.slice(0, 50);
  const choose = (object: ObjectSummary) => {
    setDraft(object.name);
    setOpen(false);
    onChange(object.name);
  };
  const known = !draft || !!objects?.some((o) => o.name.toLowerCase() === draft.trim().toLowerCase());
  return (
    <div class={`field object-combobox ${open ? 'open' : ''}`} ref={root}>
      <label for={id}>{label}</label>
      <div class="combobox-control" ref={anchor}>
        <input id={id} value={draft} placeholder={objects ? 'Search objects by label or API name' : 'Loading objects…'} autoComplete="off" spellcheck={false}
          role="combobox" aria-autocomplete="list" aria-controls={`${id}-list`} aria-expanded={open} aria-activedescendant={open && matches[active] ? `${id}-option-${active}` : undefined}
          onFocus={() => { setOpen(true); setActive(0); }}
          onInput={(e) => { setDraft(e.currentTarget.value); setOpen(true); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((n) => Math.min(matches.length - 1, n + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((n) => Math.max(0, n - 1)); }
            else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); choose(matches[active]); }
            else if (e.key === 'Escape') setOpen(false);
          }} />
        {!draft && <Icon name="search" class="field-icon" />}
        {draft && <button type="button" class="combobox-clear" aria-label={`Clear ${label}`} onClick={() => { setDraft(''); onChange(''); setOpen(true); root.current?.querySelector("input")?.focus(); }}><Icon name="close" /></button>}
      </div>
      {open && objects && <div class="combobox-options" id={`${id}-list`} role="listbox" style={popup}>
        {matches.map((o, index) => <button type="button" id={`${id}-option-${index}`} role="option" aria-selected={value === o.name} class={index === active ? 'active' : ''} key={o.name} onMouseEnter={() => setActive(index)} onClick={() => choose(o)}><strong>{objectLabel(o)}{o.custom ? <em class="tag">Custom</em> : null}</strong><span>{o.name}</span></button>)}
        {!matches.length && <p>No matching objects{showSystem ? '' : ' — system objects are hidden'}.</p>}
        {ranked.length > matches.length && <p>Showing {matches.length} of {ranked.length}. Type more to narrow the results.</p>}
        <label class="check combobox-footer"><input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.currentTarget.checked)} /> Include system objects (Share, Feed, History…)</label>
      </div>}
      {!known && <span class="hint">Not an object you can see. Pick one from the list.</span>}
    </div>
  );
}

export function FieldPicker({
  id,
  label,
  fields,
  value,
  onChange,
  optional,
  filter,
}: {
  id: string;
  label: string;
  fields: FieldInfo[] | undefined;
  value: string;
  onChange: (v: string) => void;
  optional?: boolean;
  filter?: (f: FieldInfo) => boolean;
}) {
  const list = (fields ?? []).filter(filter ?? (() => true)).sort((a, b) => a.label.localeCompare(b.label));
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const popup = usePopupStyle(open, anchor);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  const matches = useMemo(() => {
    const q = (draft === value ? '' : draft).trim().toLowerCase();
    return list.filter((f) => !q || `${f.label} ${f.name} ${f.type}`.toLowerCase().includes(q)).slice(0, 50);
  }, [list, draft]);
  const choose = (field: FieldInfo) => { setDraft(field.name); setOpen(false); onChange(field.name); };
  return (
    <div class={`field object-combobox ${open ? 'open' : ''}`} ref={root}>
      <label for={id}>{label}</label>
      <div class="combobox-control" ref={anchor}>
        <input id={id} disabled={!fields} value={draft} placeholder={fields ? (optional ? 'Search fields or leave empty' : 'Search fields by label or API name') : 'Select an object first'} autoComplete="off" spellcheck={false}
          role="combobox" aria-autocomplete="list" aria-controls={`${id}-list`} aria-expanded={open} aria-activedescendant={open && matches[active] ? `${id}-option-${active}` : undefined}
          onFocus={() => { setOpen(true); setActive(0); }} onInput={(e) => { setDraft(e.currentTarget.value); setOpen(true); setActive(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((n) => Math.max(0, Math.min(matches.length - 1, n + 1))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((n) => Math.max(0, n - 1)); }
            else if (e.key === 'Enter' && open && matches[active]) { e.preventDefault(); choose(matches[active]); }
            else if (e.key === 'Escape') setOpen(false);
          }} />
        {!draft && <Icon name="search" class="field-icon" />}
        {draft && <button type="button" class="combobox-clear" aria-label={`Clear ${label}`} onClick={() => { setDraft(''); onChange(''); setOpen(true); root.current?.querySelector("input")?.focus(); }}><Icon name="close" /></button>}
      </div>
      {open && fields && <div class="combobox-options" id={`${id}-list`} role="listbox" style={popup}>
        {optional && !draft && <button type="button" role="option" aria-selected={!value} onClick={() => { setDraft(''); onChange(''); setOpen(false); }}><strong>None</strong><span>Optional field</span></button>}
        {matches.map((f, index) => <button type="button" id={`${id}-option-${index}`} role="option" aria-selected={value === f.name} class={index === active ? 'active' : ''} key={f.name} onMouseEnter={() => setActive(index)} onClick={() => choose(f)}><strong>{f.label}</strong><span>{f.name} · {f.type}</span></button>)}
        {!matches.length && <p>No matching fields.</p>}
        {list.length > matches.length && matches.length === 50 && <p>Type more to narrow the results.</p>}
      </div>}
    </div>
  );
}

export function CacheInfo({ fetchedAt, fromCache, onRefresh, loading }: { fetchedAt?: number; fromCache?: boolean; onRefresh: () => void; loading?: boolean }) {
  return (
    <div class="row subtle">
      <span class="grow">{fetchedAt ? `${fromCache ? 'Cached' : 'Loaded'} ${new Date(fetchedAt).toLocaleString()}` : ''}</span>
      <button class="btn small" onClick={onRefresh} disabled={loading}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>
  );
}
