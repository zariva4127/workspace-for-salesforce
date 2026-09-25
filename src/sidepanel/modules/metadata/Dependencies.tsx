import { useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { ConnectionGate } from '../../components/ConnectionGate';
import { FieldPicker, ObjectPicker, useDescribe, useObjects } from '../../components/Pickers';
import { Alert, ErrorAlert, Loading } from '../../components/States';
import { isDependencyField, isDependencyObject, loadDependencies, resolveComponentId, type DependencyResult } from '../../../shared/salesforce/dependencies';

export function Dependencies() {
  const ws = useWorkspace();
  const objects = useObjects();
  const [objectName, setObjectName] = useState('');
  const [fieldName, setFieldName] = useState('');
  const describe = useDescribe(objectName);
  const [result, setResult] = useState<DependencyResult>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const supportedObjects = objects.data?.value.filter((o) => isDependencyObject(o.name));
  const inspect = async () => {
    if (!ws.client || !objectName) return;
    setLoading(true); setError(undefined); setResult(undefined); setReason('');
    try { const resolved = await resolveComponentId(ws.client, objectName, fieldName || undefined); if (!resolved.id) setReason(resolved.reason ?? 'Component not available.'); else setResult(await loadDependencies(ws.client, resolved.id)); } catch (e) { setError(e); } finally { setLoading(false); }
  };
  return <ConnectionGate>
    <section class="card stack narrow">
      <h2>Dependency view</h2>
      <Alert kind="warning" title="Results may be incomplete">Salesforce’s beta MetadataComponentDependency API omits standard components, dynamic references, and some metadata types, and caps results at 2,000 rows.</Alert>
      {objects.loading ? <Loading label="Loading objects…" /> : objects.error ? <ErrorAlert error={objects.error} onRetry={objects.run} /> : <>
        <ObjectPicker id="dependency-object" label="Custom object" value={objectName} onChange={(v) => { setObjectName(v); setFieldName(''); setResult(undefined); setReason(''); setError(undefined); }} objects={supportedObjects} />
        {supportedObjects?.length === 0 && <Alert kind="info">No supported custom objects are visible to the connected user.</Alert>}
        <FieldPicker id="dependency-field" label="Custom field (optional)" optional value={fieldName} onChange={(v) => { setFieldName(v); setResult(undefined); setReason(''); }} fields={describe.data?.value.fields} filter={(f) => isDependencyField(f.name)} />
        <button class="btn primary" disabled={!objectName || loading} onClick={() => void inspect()}>{loading ? 'Checking…' : 'Find dependencies'}</button>
      </>}
      {error && <ErrorAlert error={error} onRetry={() => void inspect()} />}{reason && <Alert kind="info">{reason}</Alert>}
    </section>
    {result && <section class="card stack"><h2>Dependency results</h2>{result.truncated && <Alert kind="warning">Salesforce returned a truncated result. More dependencies may exist.</Alert>}{([['Used by', result.usedBy], ['Uses', result.uses]] as const).map(([label, rows]) => <div key={label}><h3>{label} ({rows.length})</h3>{rows.length ? <ul class="list">{rows.map((r) => <li key={`${label}:${r.id}`}><span class="pill">{r.type}</span><span class="grow break">{r.name}</span><code>{r.id}</code></li>)}</ul> : <p class="subtle">No tracked dependencies returned.</p>}</div>)}</section>}
  </ConnectionGate>;
}
