/**
 * Lookup field input: type to search records of the target object (as the
 * user, so sharing applies), or paste an ID. Once a record is chosen it shows
 * the record's name with a clear (×) button; clearing empties the field.
 * Polymorphic lookups (e.g. Owner: User or Queue) first pick the object.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { Icon } from '../../components/Icon';
import { usePopupStyle } from '../../hooks/usePopupStyle';
import { searchLookup, recordName, type LookupOption } from '../../../shared/salesforce/records';
import { isSalesforceId, to18 } from '../../../shared/salesforce/ids';
import { explainError, isCancelled } from '../../../shared/api/errors';
import type { FieldInfo } from '../../../shared/salesforce/metadata';

export function LookupInput({
  id,
  field,
  value,
  name,
  onChange,
  invalid,
  describedBy,
  required,
}: {
  id: string;
  field: FieldInfo;
  value: string;
  name?: string;
  onChange: (id: string, name?: string) => void;
  invalid?: boolean;
  describedBy?: string;
  required?: boolean;
}) {
  const ws = useWorkspace();
  const [target, setTarget] = useState(field.referenceTo[0] ?? '');
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<LookupOption[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [message, setMessage] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const popup = usePopupStyle(open, anchor);
  const listId = `${id}-options`;

  // Show a name for IDs that arrive without one (pasted or prefilled).
  useEffect(() => {
    if (!value || name || !ws.client || !ws.metadata) return;
    const ctrl = new AbortController();
    recordName(ws.client, ws.metadata, value, ctrl.signal).then(
      (r) => r && onChange(value, r.name),
      () => undefined,
    );
    return () => ctrl.abort();
  }, [value, name]);

  // Debounced search while the user types.
  useEffect(() => {
    if (!open || value || !target || !ws.client || !ws.metadata) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setStatus('loading');
      searchLookup(ws.client!, ws.metadata!, target, term, ctrl.signal).then(
        (r) => {
          setResults(r);
          setActive(0);
          setStatus('idle');
          setMessage(undefined);
        },
        (e) => {
          if (isCancelled(e)) return;
          setStatus('error');
          setMessage(explainError(e).detail);
        },
      );
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [term, target, open, value]);

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);

  const trimmed = term.trim();
  const pastedId = isSalesforceId(trimmed) ? to18(trimmed) : undefined;
  const options: LookupOption[] = pastedId ? [{ id: pastedId, name: `Use ID ${pastedId}`, objectApiName: target }, ...results] : results;

  const choose = (o: LookupOption) => {
    onChange(o.id, o.name.startsWith('Use ID ') ? undefined : o.name);
    setTerm('');
    setOpen(false);
  };
  const clear = () => {
    onChange('', undefined);
    setTerm('');
    setOpen(true);
    setTimeout(() => inputRef.current?.focus());
  };

  return (
    <div class={`lookup object-combobox ${open ? 'open' : ''}`} ref={root}>
      {field.referenceTo.length > 1 && !value && (
        <select aria-label={`${field.label}: record type to search`} class="lookup-target" value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
          {field.referenceTo.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      )}
      <div class="combobox-control" ref={anchor}>
        {value ? (
          <>
            <input
              id={id}
              readOnly
              class="lookup-selected"
              value={name ?? value}
              title={value}
              aria-required={required}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onKeyDown={(e) => {
                if (e.key === 'Backspace' || e.key === 'Delete') {
                  e.preventDefault();
                  clear();
                }
              }}
            />
            <button type="button" class="combobox-clear" aria-label={`Clear ${field.label}`} title="Clear" onClick={clear}>
              <Icon name="close" />
            </button>
          </>
        ) : (
          <>
            <input
              ref={inputRef}
              id={id}
              value={term}
              placeholder={`Search ${target || 'records'} or paste an ID`}
              autoComplete="off"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
              aria-required={required}
              aria-invalid={invalid}
              aria-describedby={describedBy}
              onFocus={() => setOpen(true)}
              onInput={(e) => {
                setTerm(e.currentTarget.value);
                setOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setOpen(true);
                  setActive((n) => Math.min(options.length - 1, n + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((n) => Math.max(0, n - 1));
                } else if (e.key === 'Enter' && open && options[active]) {
                  e.preventDefault();
                  choose(options[active]);
                } else if (e.key === 'Escape' && open) {
                  e.stopPropagation();
                  setOpen(false);
                }
              }}
            />
            <Icon name="search" class="field-icon" />
          </>
        )}
      </div>
      {open && !value && (
        <div class="combobox-options" id={listId} role="listbox" aria-label={`${field.label} results`} style={popup}>
          {status === 'loading' && !options.length && <p>Searching…</p>}
          {status === 'error' && <p>Couldn't search: {message}</p>}
          {options.map((o, i) => (
            <button
              type="button"
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              class={i === active ? 'active' : ''}
              key={o.id + i}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
            >
              <strong>{o.name}</strong>
              <span>{o.objectApiName}</span>
            </button>
          ))}
          {status === 'idle' && !options.length && <p>{trimmed ? 'No matching records you can see.' : `Type to search ${target} records.`}</p>}
        </div>
      )}
    </div>
  );
}
