import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ConnectionGate } from '../../components/ConnectionGate';
import { ObjectPicker, useDescribe, useObjects } from '../../components/Pickers';
import { Alert, ErrorAlert, Loading } from '../../components/States';
import { SearchInput } from '../../components/SearchInput';
import { useWorkspace } from '../../state/workspace';
import { orgBigStore } from '../../services/platform';
import { downloadText, safeFilename } from '../../utils/download';
import { rowsToCsv, safeIdentifier } from '../../../shared/salesforce/dataTransfer';
import { isCancelled } from '../../../shared/api/errors';
import { soqlString } from '../../../shared/api/client';

type Rec = Record<string, unknown>;
type History = { at: number; object: string; fields: number; rows: number; filtered: boolean; cancelled?: boolean };
const HISTORY_KEY = 'data-transfer:export-history';
const CAP = 50_000;

function literal(raw: string, type: string): string {
  if (raw.toLowerCase() === 'null') return 'NULL';
  if (type === 'boolean') { if (!/^(true|false)$/i.test(raw)) throw new Error('Boolean filters must be true or false.'); return raw.toLowerCase(); }
  if (['int','double','currency','percent'].includes(type)) { if (!Number.isFinite(Number(raw))) throw new Error('Numeric filter value is invalid.'); return String(Number(raw)); }
  return soqlString(raw);
}

function ExportWorkspace() {
  const ws = useWorkspace();
  const objects = useObjects();
  const [objectName, setObjectName] = useState('');
  const desc = useDescribe(objectName || undefined);
  const [fields, setFields] = useState<string[]>([]);
  const [fieldSearch, setFieldSearch] = useState('');
  const [filterField, setFilterField] = useState('');
  const [operator, setOperator] = useState('=');
  const [filterValue, setFilterValue] = useState('');
  const [preview, setPreview] = useState<Rec[]>([]);
  const [records, setRecords] = useState<Rec[]>([]);
  const [total, setTotal] = useState(0);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState<'preview'|'export'>();
  const [error, setError] = useState<unknown>();
  const [notice, setNotice] = useState('');
  const [filterError, setFilterError] = useState('');
  const [history, setHistory] = useState<History[]>([]);
  const ctrl = useRef<AbortController>();
  const store = useMemo(() => orgBigStore(ws.org!.key), [ws.org?.key]);
  useEffect(() => { void store.get<History[]>(HISTORY_KEY).then((v) => setHistory(v ?? [])); }, [store]);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => { setFields(desc.data?.value.fields.some((f) => f.name === 'Id') ? ['Id'] : []); setFieldSearch(''); setFilterField(''); setPreview([]); setRecords([]); }, [desc.data]);

  const readable = desc.data?.value.fields.filter((f) => !f.compoundFieldName && f.type !== 'address' && f.type !== 'location') ?? [];
  const visibleFields = useMemo(() => {
    const term = fieldSearch.trim().toLowerCase();
    return readable.filter((field) => !term || `${field.label} ${field.name} ${field.type}`.toLowerCase().includes(term));
  }, [readable, fieldSearch]);
  const build = (limit?: number) => {
    if (!objectName || !fields.length) throw new Error('Select an object and at least one field.');
    let q = `SELECT ${fields.map(safeIdentifier).join(', ')} FROM ${safeIdentifier(objectName)}`;
    if (filterField) {
      const f = readable.find((x) => x.name === filterField);
      if (!f) throw new Error('Select a valid filter field.');
      if (!filterValue.trim()) throw new Error('Enter a filter value, or clear the filter field.');
      q += ` WHERE ${safeIdentifier(filterField)} ${operator} ${literal(filterValue.trim(), f.type)}`;
    }
    if (limit) q += ` LIMIT ${limit}`;
    return q;
  };

  /** Field-level check that runs before any request; returns false (and focuses the field) on a problem. */
  const validateFilter = () => {
    setFilterError('');
    if (!filterField) return true;
    let message = '';
    const f = readable.find((x) => x.name === filterField);
    if (!filterValue.trim()) message = 'Enter a value to filter by, or set the field back to “No filter”.';
    else if (f) { try { literal(filterValue.trim(), f.type); } catch (e) { message = e instanceof Error ? e.message : String(e); } }
    if (message) { setFilterError(message); setTimeout(() => document.getElementById('filter-value')?.focus()); return false; }
    return true;
  };
  const runPreview = async () => {
    if (!ws.client || !validateFilter()) return;
    const c = new AbortController(); ctrl.current = c; setBusy('preview'); setError(undefined); setNotice('');
    try { const r = await ws.client.query<Rec>(build(20), { signal: c.signal }); setPreview(r.records); setTotal(r.totalSize); }
    catch (e) { if (!isCancelled(e)) setError(e); }
    finally { if (!c.signal.aborted) setBusy(undefined); }
  };
  const runExport = async () => {
    if (!ws.client || !validateFilter()) return;
    const c = new AbortController(); ctrl.current = c; setBusy('export'); setError(undefined); setNotice(''); setRecords([]); setProgress(0);
    try {
      const r = await ws.client.queryAll<Rec>(build(), { signal: c.signal, maxRecords: CAP, onPage: (loaded, count) => { setProgress(loaded); setTotal(count); } });
      setRecords(r.records);
      if (r.truncated) setNotice(r.stoppedForLimits ? 'Stopped because the org has used over 90% of its daily API allowance.' : `Stopped at ${CAP.toLocaleString()} records. Add filters for a complete export.`);
      else setNotice(`${r.records.length.toLocaleString()} records are ready to download.`);
      const item: History = { at: Date.now(), object: objectName, fields: fields.length, rows: r.records.length, filtered: !!filterField };
      const next = [item, ...history].slice(0, 20); setHistory(next); await store.set(HISTORY_KEY, next);
    } catch (e) {
      if (isCancelled(e)) {
        setNotice('Export cancelled. Partial results were not saved or offered for download.');
        const item: History = { at: Date.now(), object: objectName, fields: fields.length, rows: progress, filtered: !!filterField, cancelled: true };
        const next = [item, ...history].slice(0, 20); setHistory(next); await store.set(HISTORY_KEY, next);
      } else setError(e);
    } finally { setBusy(undefined); }
  };

  return <>
    <section class="card stack">
      {!objectName && <p class="card-help">Choose an object, select the fields you need, optionally add one filter, then preview or export to CSV.</p>}
      <ObjectPicker id="export-object" label="Salesforce object" value={objectName} onChange={setObjectName} objects={objects.data?.value.filter((o) => o.queryable)}/>
      {desc.loading && <Loading label="Loading fields…"/>}{desc.error && <ErrorAlert error={desc.error}/>} 
      {desc.data?.value && <>
        <div class="card-title">
          <div><h2>Fields</h2><span class="subtle">{fields.length} selected · {visibleFields.length} shown</span></div>
          <div class="row">
            <button class="btn small" disabled={!visibleFields.length} onClick={() => setFields((current) => [...new Set([...current, ...visibleFields.map((field) => field.name)])])}>{fieldSearch ? 'Select visible' : 'Select all'}</button>
            <button class="btn small ghost" disabled={!fields.length} onClick={() => setFields([])}>Clear</button>
          </div>
        </div>
        <SearchInput placeholder="Search fields by label, API name, or type" label="Search export fields" value={fieldSearch} onValue={setFieldSearch} />
        <div class="field-checks">
          {visibleFields.map((f) => <label class="check" key={f.name}><input type="checkbox" checked={fields.includes(f.name)} onChange={(e) => setFields(e.currentTarget.checked ? [...fields, f.name] : fields.filter((x) => x !== f.name))}/><span>{f.label}<small>{f.name} · {f.type}</small></span></label>)}
          {!visibleFields.length && <p class="muted">No fields match “{fieldSearch}”.</p>}
        </div>
      </>}
    </section>
    {desc.data?.value && <section class="card stack"><h2>Filter</h2><div class="filter-grid"><div class="field"><label for="filter-field">Field</label><select id="filter-field" value={filterField} onChange={(e) => { setFilterField(e.currentTarget.value); setFilterError(''); }}><option value="">No filter</option>{readable.filter((f) => !['base64','textarea'].includes(f.type)).map((f) => <option value={f.name}>{f.label} ({f.name})</option>)}</select></div><div class="field"><label for="filter-op">Operator</label><select id="filter-op" value={operator} onChange={(e) => setOperator(e.currentTarget.value)}><option>=</option><option>!=</option><option>&gt;</option><option>&gt;=</option><option>&lt;</option><option>&lt;=</option></select></div><div class="field"><label for="filter-value">Value</label><input id="filter-value" value={filterValue} disabled={!filterField} aria-invalid={!!filterError} aria-describedby={filterError ? 'filter-value-err' : undefined} onInput={(e) => { setFilterValue(e.currentTarget.value); setFilterError(''); }}/>{filterError && <span id="filter-value-err" class="field-error" role="alert">{filterError}</span>}</div></div><span class="hint">Filters are built from selected fields and typed values; raw SOQL is not accepted here.</span>
      {!fields.length && <span class="hint">Select at least one field above to enable preview and export.</span>}
      <div class="row">{busy ? <button class="btn" onClick={() => ctrl.current?.abort()}>Cancel</button> : <><button class="btn" disabled={!fields.length} onClick={() => void runPreview()}>Preview records</button><button class="btn primary" disabled={!fields.length} onClick={() => void runExport()}>Start export</button></>}</div>
      {busy === 'export' && <><progress max={Math.max(total, 1)} value={progress}/><span class="hint">Loaded {progress.toLocaleString()} of {total.toLocaleString()} records.</span></>}
    </section>}
    {error && <ErrorAlert error={error}/>} {notice && <Alert kind="info">{notice}</Alert>}
    {preview.length > 0 && <section class="card stack"><div class="card-title"><h2>Record preview</h2><span class="subtle">Up to 20 records</span></div><div class="table-wrap"><table><thead><tr>{fields.map((f) => <th>{f}</th>)}</tr></thead><tbody>{preview.map((r) => <tr>{fields.map((f) => <td>{String(r[f] ?? '')}</td>)}</tr>)}</tbody></table></div></section>}
    {records.length > 0 && <section class="card stack"><div class="card-title"><h2>CSV ready</h2><button class="btn primary" onClick={() => downloadText(`${safeFilename(objectName)}-${new Date().toISOString().slice(0,10)}.csv`, rowsToCsv(fields, records), 'text/csv')}>Download {records.length.toLocaleString()} rows</button></div><span class="hint">The generated CSV remains in memory until you leave this tool or change orgs.</span></section>}
    {history.length > 0 && <details class="card"><summary>Export history ({history.length})</summary><ul class="list">{history.map((h) => <li><span class="grow">{new Date(h.at).toLocaleString()} · {h.object} · {h.fields} fields</span><span>{h.cancelled ? 'Cancelled' : `${h.rows} rows`}</span></li>)}</ul></details>}
  </>;
}

export function DataExport() { return <ConnectionGate><ExportWorkspace/></ConnectionGate>; }
