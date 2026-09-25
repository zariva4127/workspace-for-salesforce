import { useMemo, useState } from 'preact/hooks';
import { ConnectionGate } from '../../components/ConnectionGate';
import { FieldPicker, ObjectPicker, useDescribe, useObjects } from '../../components/Pickers';
import { ErrorAlert, Loading } from '../../components/States';
import { checkMapping } from '../../../shared/mapping/fieldMapping';

export function FieldMapping() {
  const objects = useObjects();
  const [sourceObject, setSourceObject] = useState('');
  const [targetObject, setTargetObject] = useState('');
  const [sourceField, setSourceField] = useState('');
  const [targetField, setTargetField] = useState('');
  const [operation, setOperation] = useState<'insert' | 'update'>('insert');
  const source = useDescribe(sourceObject);
  const target = useDescribe(targetObject);
  const sourceInfo = source.data?.value.fields.find((f) => f.name === sourceField);
  const targetInfo = target.data?.value.fields.find((f) => f.name === targetField);
  const issues = useMemo(() => sourceInfo && targetInfo ? checkMapping(sourceInfo, targetInfo, { isInsert: operation === 'insert' }) : [], [sourceInfo, targetInfo, operation]);
  return <ConnectionGate>
    <section class="card stack narrow">
      <h2>Field mapping helper</h2>
      <p class="muted">Flags obvious type, size, relationship, and write-access problems. It does not inspect validation rules, automation, or your source data.</p>
      {objects.loading ? <Loading label="Loading objects…" /> : objects.error ? <ErrorAlert error={objects.error} onRetry={objects.run} /> : <>
        <ObjectPicker id="source-object" label="Source object" value={sourceObject} onChange={(v) => { setSourceObject(v); setSourceField(''); }} objects={objects.data?.value} />
        {source.error && <ErrorAlert error={source.error} onRetry={source.run} />}
        <FieldPicker id="source-field" label="Source field" value={sourceField} onChange={setSourceField} fields={source.data?.value.fields} />
        <ObjectPicker id="target-object" label="Target object" value={targetObject} onChange={(v) => { setTargetObject(v); setTargetField(''); }} objects={objects.data?.value} />
        {target.error && <ErrorAlert error={target.error} onRetry={target.run} />}
        <FieldPicker id="target-field" label="Target field" value={targetField} onChange={setTargetField} fields={target.data?.value.fields} />
        <div class="field"><label for="mapping-operation">Operation</label><select id="mapping-operation" value={operation} onChange={(e) => setOperation(e.currentTarget.value as 'insert' | 'update')}><option value="insert">Insert</option><option value="update">Update</option></select></div>
      </>}
    </section>
    {sourceInfo && targetInfo && <section class="card stack" aria-live="polite"><h2>Compatibility result</h2>{issues.length ? issues.map((issue, i) => <div key={i} class={`alert ${issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info'}`}><strong>{issue.severity === 'error' ? 'Blocker' : issue.severity === 'warning' ? 'Check required' : 'Note'}</strong>{issue.message}</div>) : <div class="alert success"><strong>No obvious mismatch</strong>The field definitions are compatible under this conservative check. Test with representative data before migrating.</div>}</section>}
  </ConnectionGate>;
}
