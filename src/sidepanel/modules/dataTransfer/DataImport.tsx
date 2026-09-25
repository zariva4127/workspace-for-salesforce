import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ConnectionGate } from '../../components/ConnectionGate';
import { ObjectPicker, useDescribe, useObjects } from '../../components/Pickers';
import { Alert, ErrorAlert, Loading } from '../../components/States';
import { useConfirm } from '../../components/ConfirmDialog';
import { useWorkspace } from '../../state/workspace';
import { orgBigStore } from '../../services/platform';
import { downloadText, safeFilename } from '../../utils/download';
import { autoMap, parseCsv, prepareImport, rowsToCsv, type CsvTable, type ImportOperation } from '../../../shared/salesforce/dataTransfer';
import { isCancelled } from '../../../shared/api/errors';

type Result = { row: number; success: boolean; id?: string; error?: string };
type History = { at: number; operation: ImportOperation; object: string; rows: number; succeeded: number; failed: number };
const HISTORY_KEY = 'data-transfer:import-history';

function ImportWorkspace() {
  const ws = useWorkspace();
  const objects = useObjects();
  const [objectName, setObjectName] = useState('');
  const desc = useDescribe(objectName || undefined);
  const [operation, setOperation] = useState<ImportOperation>('insert');
  const [table, setTable] = useState<CsvTable>();
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [externalId, setExternalId] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [history, setHistory] = useState<History[]>([]);
  const ctrl = useRef<AbortController>();
  const [confirm, confirmElement] = useConfirm();
  const store = useMemo(() => orgBigStore(ws.org!.key), [ws.org?.key]);

  useEffect(() => { void store.get<History[]>(HISTORY_KEY).then((v) => setHistory(v ?? [])); }, [store]);
  useEffect(() => () => ctrl.current?.abort(), []);
  useEffect(() => {
    if (!table || !desc.data?.value) return;
    setMapping(autoMap(table.headers, desc.data.value.fields, operation));
    setExternalId('');
    setResults([]);
  }, [table, desc.data, operation]);

  const prepared = useMemo(() => table && desc.data?.value ? prepareImport(table, desc.data.value, mapping, operation, externalId) : undefined, [table, desc.data, mapping, operation, externalId]);
  const eligible = desc.data?.value.fields.filter((f) => operation === 'insert' ? f.createable : f.updateable || f.name === 'Id') ?? [];
  const externalFields = desc.data?.value.fields.filter((f) => f.externalId && f.updateable) ?? [];

  const readFile = async (file?: File) => {
    if (!file) return;
    setError(undefined); setResults([]);
    try {
      const parsed = parseCsv(await file.text());
      if (parsed.rows.length > 10_000) throw new Error('This version accepts up to 10,000 rows per import. Split the file and try again.');
      setFileName(file.name); setTable(parsed);
    } catch (e) { setTable(undefined); setError(e); }
  };

  const run = async () => {
    if (!ws.client || !table || !desc.data?.value || !prepared || prepared.issues.length) return;
    const ok = await confirm({
      title: `Confirm ${operation}`,
      body: <p>This will {operation} {prepared.records.length.toLocaleString()} {desc.data.value.label} records in <strong>{ws.org?.username ?? ws.org?.myDomain}</strong>. Salesforce validation rules, automation, sharing, object permissions, and field permissions apply.</p>,
      confirmLabel: `${operation[0]!.toUpperCase()}${operation.slice(1)} records`,
      danger: true,
    });
    if (!ok) return;
    const c = new AbortController(); ctrl.current = c; setBusy(true); setError(undefined); setResults([]); setProgress(0);
    const out: Result[] = [];
    try {
      // Small client-side batches keep progress responsive and avoid a large in-memory request body.
      for (let start = 0; start < prepared.records.length; start += 25) {
        const batch = prepared.records.slice(start, start + 25);
        const settled = await Promise.all(batch.map(async (source, j): Promise<Result> => {
          const row = start + j + 2;
          try {
            const record = { ...source };
            if (operation === 'insert') {
              delete record.Id;
              const r = await ws.client!.createRecord(objectName, record, c.signal);
              return { row, success: true, id: r.id };
            }
            if (operation === 'update') {
              const id = String(record.Id ?? ''); delete record.Id;
              await ws.client!.updateRecord(objectName, id, record, { signal: c.signal });
              return { row, success: true, id };
            }
            const value = String(record[externalId] ?? ''); delete record[externalId]; delete record.Id;
            const r = await ws.client!.upsertRecord(objectName, externalId, value, record, c.signal);
            return { row, success: true, ...(r?.id ? { id: r.id } : {}) };
          } catch (e) { if (isCancelled(e)) throw e; return { row, success: false, error: e instanceof Error ? e.message : String(e) }; }
        }));
        out.push(...settled); setResults([...out]); setProgress(out.length);
      }
      const item: History = { at: Date.now(), operation, object: objectName, rows: out.length, succeeded: out.filter((r) => r.success).length, failed: out.filter((r) => !r.success).length };
      const next = [item, ...history].slice(0, 20); setHistory(next); await store.set(HISTORY_KEY, next);
    } catch (e) { if (!isCancelled(e)) setError(e); }
    finally { setBusy(false); }
  };

  return <>
    <section class="card stack narrow">
      <p class="card-help">Choose a CSV, pick the Salesforce object and operation, then map columns and review before anything is written.</p>
      <div class="field"><label for="import-file">CSV file</label><input id="import-file" type="file" accept=".csv,text/csv" onChange={(e) => void readFile(e.currentTarget.files?.[0])}/><span class="hint">Processed in memory. CSV contents are not saved in extension storage.</span></div>
      {table && <Alert kind="info">{fileName}: {table.rows.length.toLocaleString()} data rows, {table.headers.length} columns.</Alert>}
      <ObjectPicker id="import-object" label="Salesforce object" value={objectName} onChange={setObjectName} objects={objects.data?.value.filter((o) => o.createable || o.updateable)} />
      <div class="field"><label for="import-operation">Operation</label><select id="import-operation" value={operation} onChange={(e) => setOperation(e.currentTarget.value as ImportOperation)}><option value="insert">Insert</option><option value="update">Update</option><option value="upsert">Upsert</option></select></div>
      {operation === 'upsert' && <div class="field"><label for="external-id">External ID field</label><select id="external-id" value={externalId} onChange={(e) => setExternalId(e.currentTarget.value)}><option value="">Select an external ID</option>{externalFields.map((f) => <option value={f.name}>{f.label} ({f.name})</option>)}</select></div>}
    </section>
    {desc.loading && <Loading label="Loading fields…"/>}{desc.error && <ErrorAlert error={desc.error}/>} {error && <ErrorAlert error={error}/>} 
    {table && desc.data?.value && <section class="card stack"><div class="card-title"><h2>Column mapping</h2><span class="pill">{Object.values(mapping).filter(Boolean).length}/{table.headers.length} mapped</span></div>
      <div class="mapping-grid">{table.headers.map((h) => <div class="field" key={h}><label for={`map-${h}`}>{h}</label><select id={`map-${h}`} value={mapping[h] ?? ''} onChange={(e) => setMapping({ ...mapping, [h]: e.currentTarget.value })}><option value="">Do not import</option>{eligible.map((f) => <option value={f.name}>{f.label} ({f.name})</option>)}</select></div>)}</div>
      {prepared && prepared.issues.length > 0 && <Alert kind="warning" title={`${prepared.issues.length} validation issue${prepared.issues.length === 1 ? '' : 's'}`}>{prepared.issues.slice(0, 8).map((x) => <div>Row {x.row || 'mapping'}{x.field ? ` · ${x.field}` : ''}: {x.message}</div>)}{prepared.issues.length > 8 && <div>…and {prepared.issues.length - 8} more.</div>}</Alert>}
    </section>}
    {prepared && table && <section class="card stack"><div class="card-title"><h2>Preview</h2><span class="subtle">First 10 rows</span></div><div class="table-wrap"><table><thead><tr><th>CSV row</th>{Object.values(mapping).filter(Boolean).map((h) => <th>{h}</th>)}</tr></thead><tbody>{prepared.records.slice(0, 10).map((r, i) => <tr><td>{i + 2}</td>{Object.values(mapping).filter(Boolean).map((h) => <td>{String(r[h] ?? '')}</td>)}</tr>)}</tbody></table></div>
      <div class="row"><button class="btn primary" disabled={busy || !!prepared.issues.length || !prepared.records.length} onClick={() => void run()}>Review & submit</button>{busy && <button class="btn" onClick={() => ctrl.current?.abort()}>Cancel</button>}<span class="grow"/><span>{busy ? `${progress}/${prepared.records.length}` : ''}</span></div>{busy && <progress max={prepared.records.length} value={progress}/>}</section>}
    {results.length > 0 && <section class="card stack"><div class="card-title"><h2>Row results</h2><button class="btn small" onClick={() => downloadText(`${safeFilename(objectName)}-${operation}-results.csv`, rowsToCsv(['row','success','id','error'], results), 'text/csv')}>Download CSV</button></div><Alert kind={results.some((r) => !r.success) ? 'warning' : 'success'}>{results.filter((r) => r.success).length} succeeded; {results.filter((r) => !r.success).length} failed.</Alert></section>}
    {history.length > 0 && <details class="card"><summary>Import history ({history.length})</summary><ul class="list">{history.map((h) => <li><span class="grow">{new Date(h.at).toLocaleString()} · {h.operation} {h.object}</span><span>{h.succeeded} succeeded · {h.failed} failed</span></li>)}</ul></details>}
    {confirmElement}
  </>;
}

export function DataImport() { return <ConnectionGate><ImportWorkspace/></ConnectionGate>; }
