/**
 * Read-only SOQL workspace. Uses the /query (or Tooling /query) endpoint, which
 * cannot modify data. Adds pagination, cancellation, per-org history, and CSV export.
 */
import { SearchInput } from '../../components/SearchInput';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { ConnectionGate } from '../../components/ConnectionGate';
import { Alert, ErrorAlert, Loading } from '../../components/States';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { FavoriteButton } from '../../components/FavoriteControls';
import { ObjectPicker, useDescribe, useObjects } from '../../components/Pickers';
import { profiles } from '../../services/platform';
import { downloadText } from '../../utils/download';
import { buildSelectQuery, flattenRecords, toCsv, validateSoql } from '../../../shared/parsers/soql';
import { isCancelled } from '../../../shared/api/errors';
import type { QueryResult } from '../../../shared/api/client';
import { isSalesforceId } from '../../../shared/salesforce/ids';
import { duplicateQuery, renameQuery, saveQuery, type SavedQuery } from '../../../shared/workspace/savedQueries';

type Rec = Record<string, unknown>;
const HISTORY_KEY = 'soqlHistory';
const MAX_HISTORY = 20;
const FETCH_ALL_CAP = 10_000;
const SAVED_KEY = 'savedQueries';

function QueryBuilder({ initialObject, onUse }: { initialObject?: string; onUse: (query: string) => void }) {
  const objects = useObjects();
  const [objectApiName, setObjectApiName] = useState(initialObject ?? '');
  const describe = useDescribe(objectApiName || undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const [fieldFilter, setFieldFilter] = useState('');
  const [limit, setLimit] = useState(100);

  useEffect(() => {
    const fields = describe.data?.value.fields;
    if (!fields?.length) return;
    const defaults = ['Id', fields.find((field) => field.nameField)?.name].filter((name): name is string => !!name && fields.some((field) => field.name === name));
    setSelected(defaults);
  }, [objectApiName, describe.data]);

  const fields = useMemo(
    () => [...(describe.data?.value.fields ?? [])].filter((field) => !field.compoundFieldName).sort((a, b) => a.label.localeCompare(b.label)),
    [describe.data],
  );
  const visible = useMemo(() => {
    const term = fieldFilter.trim().toLowerCase();
    return fields.filter((field) => !term || `${field.label} ${field.name} ${field.type}`.toLowerCase().includes(term));
  }, [fields, fieldFilter]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = (name: string) => setSelected((current) => current.includes(name) ? current.filter((field) => field !== name) : [...current, name]);
  const canBuild = !!objectApiName && selected.length > 0 && !describe.loading && !describe.error;

  return (
    <details class="query-builder">
      <summary><span>Query builder</span><span class="subtle">Choose an object and fields</span></summary>
      <div class="query-builder-body">
        <div class="query-builder-controls">
          <ObjectPicker
            id="soql-builder-object"
            label="Object"
            value={objectApiName}
            objects={objects.data?.value.filter((object) => object.queryable)}
            onChange={(value) => { setObjectApiName(value); setSelected([]); setFieldFilter(''); }}
          />
          <div class="field query-limit-field">
            <label for="soql-builder-limit">Row limit</label>
            <input id="soql-builder-limit" type="number" min="1" max="50000" value={limit} onInput={(event) => setLimit(Number(event.currentTarget.value))} />
          </div>
        </div>
        {objects.error && <ErrorAlert error={objects.error} onRetry={objects.run} />}
        {objectApiName && describe.loading && !describe.data && <Loading label="Loading fields…" />}
        {describe.error && <ErrorAlert error={describe.error} onRetry={describe.run} />}
        {describe.data && (
          <div class="stack query-field-panel">
            <div class="query-field-toolbar">
              <SearchInput placeholder="Find fields by label, API name, or type" label="Find fields" value={fieldFilter} onValue={setFieldFilter} />
              <span class="pill info">{selected.length} selected</span>
              <button type="button" class="btn small" disabled={!visible.length} onClick={() => setSelected((current) => [...new Set([...current, ...visible.map((field) => field.name)])])}>Select visible</button>
              <button type="button" class="btn small ghost" disabled={!selected.length} onClick={() => setSelected([])}>Clear</button>
            </div>
            <div class="query-field-list" role="group" aria-label={`${describe.data.value.label} fields`}>
              {visible.map((field) => (
                <label class="query-field-option" key={field.name}>
                  <input type="checkbox" checked={selectedSet.has(field.name)} onChange={() => toggle(field.name)} />
                  <span><strong>{field.label}</strong><small>{field.name} · {field.type}</small></span>
                </label>
              ))}
              {!visible.length && <p class="muted">No fields match this search.</p>}
            </div>
          </div>
        )}
        <div class="row query-builder-actions">
          <span class="hint grow">Creates a standard read-only SOQL query. You can edit it before running.</span>
          <button type="button" class="btn primary" disabled={!canBuild} onClick={() => onUse(buildSelectQuery(objectApiName, selected, limit))}>Use query</button>
        </div>
      </div>
    </details>
  );
}

function Workspace() {
  const ws = useWorkspace();
  const store = useMemo(() => profiles.scoped(ws.org!.key), [ws.org?.key]);
  const initial = ws.route.params?.query ?? (ws.orgMatchesTab && ws.page.objectApiName ? `SELECT Id, Name FROM ${ws.page.objectApiName} ORDER BY LastModifiedDate DESC LIMIT 20` : 'SELECT Id, Name FROM Account LIMIT 20');
  const [query, setQuery] = useState(initial);
  const [tooling, setTooling] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [saveName, setSaveName] = useState('');
  const [records, setRecords] = useState<Rec[]>([]);
  const [page, setPage] = useState<QueryResult<Rec> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState<string>();
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void Promise.all([store.get<string[]>(HISTORY_KEY), store.get<SavedQuery[]>(SAVED_KEY)]).then(([h, s]) => { setHistory(h ?? []); setSaved(s ?? []); });
  }, [store]);
  useEffect(() => {
    if (ws.route.params?.query) setQuery(ws.route.params.query);
  }, [ws.route.params?.query]);
  useEffect(() => () => ctrlRef.current?.abort(), []);

  const validation = validateSoql(query);
  const writeSaved = async (next: SavedQuery[]) => { setSaved(next); await store.set(SAVED_KEY, next); };

  const start = (label: string) => {
    ctrlRef.current?.abort();
    const c = new AbortController();
    ctrlRef.current = c;
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    return c.signal;
  };

  const run = async () => {
    if (!ws.client || !validation.ok) return;
    const signal = start('Running query…');
    try {
      const res = await ws.client.query<Rec>(query.trim(), { tooling, signal });
      setRecords(res.records);
      setSort(null);
      setPage(res);
      const next = [query.trim(), ...history.filter((h) => h !== query.trim())].slice(0, MAX_HISTORY);
      setHistory(next);
      await store.set(HISTORY_KEY, next);
    } catch (e) {
      if (!isCancelled(e)) setError(e);
    } finally {
      if (!signal.aborted) setBusy(null);
    }
  };

  const runSaved = async (savedQuery: SavedQuery) => {
    if (!ws.client) return;
    setQuery(savedQuery.query); setTooling(savedQuery.tooling);
    const signal = start(`Running ${savedQuery.name}…`);
    try {
      const res = await ws.client.query<Rec>(savedQuery.query, { tooling: savedQuery.tooling, signal });
      setRecords(res.records); setSort(null); setPage(res);
      const next = [savedQuery.query, ...history.filter((h) => h !== savedQuery.query)].slice(0, MAX_HISTORY);
      setHistory(next); await store.set(HISTORY_KEY, next);
    } catch (e) { if (!isCancelled(e)) setError(e); }
    finally { if (!signal.aborted) setBusy(null); }
  };

  const more = async (all: boolean) => {
    if (!ws.client || !page?.nextRecordsUrl) return;
    const signal = start(all ? 'Loading all pages…' : 'Loading more…');
    let current = page;
    let acc = records;
    try {
      do {
        if ((ws.client.usageRatio() ?? 0) > 0.9) {
          setNotice('Stopped: the org has used more than 90% of its daily API requests.');
          break;
        }
        current = await ws.client.queryMore<Rec>(current.nextRecordsUrl!, signal);
        acc = [...acc, ...current.records];
        setRecords(acc);
        setPage(current);
        setBusy(`Loaded ${acc.length.toLocaleString()} of ${current.totalSize.toLocaleString()}…`);
      } while (all && current.nextRecordsUrl && acc.length < FETCH_ALL_CAP);
      if (all && current.nextRecordsUrl) setNotice(`Stopped at ${FETCH_ALL_CAP.toLocaleString()} records. Narrow the query or export in batches.`);
    } catch (e) {
      if (!isCancelled(e)) setError(e);
    } finally {
      if (!signal.aborted) setBusy(null);
    }
  };

  const cancel = () => {
    ctrlRef.current?.abort();
    setBusy(null);
    setNotice('Cancelled.');
  };

  const { columns, rows } = useMemo(() => flattenRecords(records), [records]);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const filtered = f ? rows.filter((r) => Object.values(r).some((v) => String(v ?? '').toLowerCase().includes(f))) : rows;
    if (!sort) return filtered;
    const key = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'number' ? v : String(v).toLowerCase());
    return [...filtered].sort((a, b) => {
      const x = key(a[sort.col]);
      const y = key(b[sort.col]);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
    });
  }, [rows, filter, sort]);

  return (
    <>
      <section class="card stack">
        <details open={saved.length > 0}>
          <summary>Saved queries ({saved.length})</summary>
          <div class="stack saved-query-panel">
            <form class="row" onSubmit={(e) => { e.preventDefault(); if (!validation.ok || !saveName.trim()) return; void writeSaved(saveQuery(saved, { name: saveName.trim(), query: query.trim(), tooling })); setSaveName(''); }}>
              <input class="grow" aria-label="Saved query name" placeholder="Name this query" value={saveName} onInput={(e) => setSaveName(e.currentTarget.value)} />
              <button class="btn small" disabled={!validation.ok || !saveName.trim()}>Save current</button>
            </form>
            {saved.length === 0 ? <p class="muted">Save frequently used queries for this org.</p> : <ul class="list compact">{saved.map((s) => <li key={s.id}>
              <div class="grow"><strong>{s.name}</strong><div class="subtle ellipsis"><code>{s.query}</code></div></div>
              {s.tooling && <span class="pill">Tooling</span>}
              <button class="btn small" onClick={() => { setQuery(s.query); setTooling(s.tooling); }}>Use</button>
              <details class="menu"><summary class="icon-btn" aria-label={`Actions for ${s.name}`}>⋯</summary><div class="menu-list">
                <button class="btn small ghost" onClick={() => { const name = window.prompt('Rename saved query', s.name)?.trim(); if (name) void writeSaved(renameQuery(saved, s.id, name)); }}>Rename</button>
                <button class="btn small ghost" onClick={() => void writeSaved(duplicateQuery(saved, s.id))}>Duplicate</button>
                <button class="btn small ghost" onClick={() => void runSaved(s)}>Run</button>
                <button class="btn small ghost danger" onClick={() => void writeSaved(saved.filter((x) => x.id !== s.id))}>Delete</button>
              </div></details>
            </li>)}</ul>}
          </div>
        </details>
        <QueryBuilder initialObject={validation.objectName} onUse={(built) => { setQuery(built); setTooling(false); }} />
        <div class="field">
          <label for="soql">SOQL query</label>
          <textarea
            id="soql"
            class="code"
            rows={5}
            value={query}
            spellcheck={false}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
            aria-describedby="soql-help"
          />
          <span id="soql-help" class="hint">
            Read-only: only SELECT queries run. Ctrl/Cmd+Enter to run. Results respect your sharing and field-level security.
          </span>
        </div>
        <div class="row">
          <label class="check">
            <input type="checkbox" checked={tooling} onChange={(e) => setTooling(e.currentTarget.checked)} /> Tooling API
          </label>
          <span class="grow" />
          {validation.ok && <FavoriteButton kind="query" value={query.trim()} defaultLabel={`${validation.objectName} query`} />}
          {busy ? (
            <button class="btn" onClick={cancel}>
              <Icon name="stop" /> Cancel
            </button>
          ) : (
            <button class="btn primary" onClick={run} disabled={!validation.ok}>
              Run
            </button>
          )}
        </div>
        {!validation.ok && query.trim() && <Alert kind="warning">{validation.error}</Alert>}
        {validation.ok && !validation.hasLimit && <span class="hint">Tip: add LIMIT to keep results fast and API usage low.</span>}
      </section>

      {busy && <Loading label={busy} />}
      {error ? <ErrorAlert error={error} onRetry={run} /> : null}
      {notice && <Alert kind="info">{notice}</Alert>}

      {page && (
        <section class="card stack" aria-labelledby="soql-res">
          <div class="card-title">
            <h2 id="soql-res">
              {records.length.toLocaleString()} of {page.totalSize.toLocaleString()} rows
              {shown.length !== records.length ? ` · ${shown.length.toLocaleString()} shown` : ''}
            </h2>
            <div class="row">
              <button class="btn small" disabled={!records.length} onClick={() => downloadText(`soql-${Date.now()}.csv`, toCsv(columns, rows), 'text/csv')}>
                <Icon name="download" /> CSV
              </button>
              {records.length > 0 && <CopyButton value={toCsv(columns, rows)} label="Copy results as CSV" />}
            </div>
          </div>
          {records.length > 0 && (
            <div class="filter-bar">
              <SearchInput placeholder="Filter loaded rows" label="Filter loaded rows" value={filter} onValue={setFilter} />
              {(filter || sort) && (
                <button class="btn small ghost" onClick={() => { setFilter(''); setSort(null); }}>
                  Clear filter & sort
                </button>
              )}
            </div>
          )}
          {records.length === 0 ? (
            <p class="muted">No rows returned.</p>
          ) : (
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c} scope="col" aria-sort={sort?.col === c ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                        <button class="sort" onClick={() => setSort((s) => (s?.col === c ? (s.dir === 1 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 }))} title="Sort by this column">
                          {c}
                          <span aria-hidden="true">{sort?.col === c ? (sort.dir === 1 ? '▲' : '▼') : ''}</span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 500).map((r, i) => (
                    <tr key={i}>
                      {columns.map((c) => {
                        const v = r[c];
                        const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                        return (
                          <td key={c} class="break">
                            {!tooling && c.endsWith('Id') && isSalesforceId(s) ? (
                              <button class="link-button mono" onClick={() => ws.navigate({ tool: 'record', params: { recordId: s } })}>{s}</button>
                            ) : (
                              s
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shown.length > 500 && <p class="subtle">Showing the first 500 rows. Export CSV to see everything that's loaded.</p>}
          {page.nextRecordsUrl && !busy && (
            <div class="row">
              <button class="btn" onClick={() => void more(false)}>
                Load next page
              </button>
              <button class="btn" onClick={() => void more(true)}>
                Load all (up to {FETCH_ALL_CAP.toLocaleString()})
              </button>
            </div>
          )}
        </section>
      )}

      {history.length > 0 && (
        <details class="card query-history">
          <summary>Query history ({history.length})</summary>
          <ul class="list">
            {history.map((h) => (
              <li key={h}>
                <code class="grow break">{h}</code>
                <button class="btn small" onClick={() => setQuery(h)}>Use</button>
              </li>
            ))}
          </ul>
          <button
            class="btn small"
            onClick={async () => {
              setHistory([]);
              await store.remove(HISTORY_KEY);
            }}
          >
            Clear history
          </button>
        </details>
      )}
    </>
  );
}

export function SoqlWorkspace() {
  return (
    <ConnectionGate>
      <Workspace />
    </ConnectionGate>
  );
}
