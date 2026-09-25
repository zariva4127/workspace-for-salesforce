/**
 * Search across tools (and, when metadata is cached, across objects).
 * Implements the ARIA combobox pattern: arrow keys move, Enter opens, Escape closes.
 * Ctrl/Cmd+K focuses it from anywhere in the panel.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { searchTools, type Route } from '../state/routes';
import { useWorkspace } from '../state/workspace';
import type { ObjectSummary } from '../../shared/salesforce/metadata';
import { Icon } from './Icon';

interface Item {
  key: string;
  group: 'Tools' | 'Objects' | 'Actions';
  label: string;
  desc: string;
  route: Route;
}

export function ToolSearch() {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Object search uses cached describeGlobal only when it's already loaded or cheap to load.
  useEffect(() => {
    setObjects([]);
    if (!open || !ws.metadata) return;
    const ctrl = new AbortController();
    ws.metadata.objects({ signal: ctrl.signal }).then(
      (r) => setObjects(r.value),
      () => undefined,
    );
    return () => ctrl.abort();
  }, [open, ws.metadata]);

  const items = useMemo<Item[]>(() => {
    const tools = searchTools(q).map<Item>((t) => ({ key: `t:${t.id}`, group: 'Tools', label: t.label, desc: t.description, route: { tool: t.id } }));
    const term = q.trim().toLowerCase();
    const objs =
      term.length >= 2
        ? objects
            .filter((o) => o.name.toLowerCase().includes(term) || o.label.toLowerCase().includes(term))
            .slice(0, 6)
            .map<Item>((o) => ({ key: `o:${o.name}`, group: 'Objects', label: o.label, desc: o.name, route: { tool: 'objects', params: { objectApiName: o.name } } }))
        : [];
    const actions: Item[] = [];
    if (/^select\s/i.test(q.trim())) actions.push({ key: 'a:soql', group: 'Actions', label: 'Run this SOQL query', desc: q.trim().slice(0, 60), route: { tool: 'soql', params: { query: q.trim() } } });
    return [...actions, ...tools, ...objs];
  }, [q, objects]);

  useEffect(() => setActive(0), [q]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    ws.navigate(item.route);
    setQ('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  let lastGroup = '';
  return (
    <div class="search search-field">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls="tool-search-results"
        aria-activedescendant={open && items[active] ? `ts-${items[active].key}` : undefined}
        aria-autocomplete="list"
        aria-label="Search tools and objects"
        placeholder="Search tools, objects…  (Ctrl+K)"
        value={q}
        onInput={(e) => {
          setQ(e.currentTarget.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {q && (
        <button
          type="button"
          class="field-clear"
          aria-label="Clear search"
          title="Clear"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQ('');
            inputRef.current?.focus();
          }}
        >
          <Icon name="close" />
        </button>
      )}
      <Icon name="search" class="field-icon" />
      {open && (
        <ul id="tool-search-results" class="search-results" role="listbox" aria-label="Search results">
          {items.length === 0 && (
            <li role="option" aria-selected="false" aria-disabled="true" class="desc">
              No matches
            </li>
          )}
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return [
              header && (
                <li key={`g-${header}`} class="group" role="presentation">
                  {header}
                </li>
              ),
              <li
                key={item.key}
                id={`ts-${item.key}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(item);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <div>{item.label}</div>
                <div class="desc">{item.desc}</div>
              </li>,
            ];
          })}
        </ul>
      )}
    </div>
  );
}
