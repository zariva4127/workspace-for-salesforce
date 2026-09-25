import { useEffect, useMemo, useState } from 'preact/hooks';
import { SearchInput } from '../../components/SearchInput';
import { ConnectionGate } from '../../components/ConnectionGate';
import { CacheInfo, ObjectPicker, useDescribe, useObjects } from '../../components/Pickers';
import { CopyButton } from '../../components/CopyButton';
import { EmptyState, ErrorAlert, Loading } from '../../components/States';
import { useWorkspace } from '../../state/workspace';
import { FavoriteButton } from '../../components/FavoriteControls';
import { NewRecordButton } from '../records/NewRecordButton';
import { Icon } from '../../components/Icon';
import { objectManagerUrl } from '../../../shared/salesforce/links';

export function ObjectExplorer() {
  const ws = useWorkspace();
  const [objectName, setObjectName] = useState(ws.route.params?.objectApiName ?? '');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState<'label' | 'name' | 'type'>('label');
  const [refresh, setRefresh] = useState(0);
  const objects = useObjects(refresh);
  const describe = useDescribe(objectName, refresh);
  const fields = useMemo(() => {
    const term = query.trim().toLowerCase();
    return (describe.data?.value.fields ?? [])
      .filter((f) => !term || `${f.label} ${f.name} ${f.type} ${f.referenceTo.join(' ')}`.toLowerCase().includes(term))
      .filter((f) => type === 'all' || f.type === type)
      .sort((a, b) => String(a[sort]).localeCompare(String(b[sort])));
  }, [describe.data, query, type, sort]);
  useEffect(() => { if (ws.route.params?.objectApiName) setObjectName(ws.route.params.objectApiName); }, [ws.route.params?.objectApiName]);
  const types = useMemo(() => [...new Set((describe.data?.value.fields ?? []).map((f) => f.type))].sort(), [describe.data]);

  return <ConnectionGate>
    <section class="card stack narrow">
      {objects.loading && !objects.data ? <Loading label="Loading objects…" /> : objects.error ? <ErrorAlert error={objects.error} onRetry={objects.run} /> : <>
        <ObjectPicker id="metadata-object" label="Object" value={objectName} onChange={setObjectName} objects={objects.data?.value} />
        <CacheInfo fetchedAt={objects.data?.fetchedAt} fromCache={objects.data?.fromCache} loading={objects.loading} onRefresh={() => setRefresh((n) => n + 1)} />
      </>}
    </section>
    {!objectName ? <EmptyState title="Pick an object to see its fields" icon="search"><p>Search by label or API name. System objects (Share, Feed, History) are hidden unless you include them.</p></EmptyState> : describe.loading ? <Loading label={`Describing ${objectName}…`} /> : describe.error ? <ErrorAlert error={describe.error} onRetry={describe.run} /> : describe.data && <section class="card stack">
      <div class="record-head">
        <div class="grow"><div class="subtle row nowrap"><code>{describe.data.value.name}</code><CopyButton value={describe.data.value.name} label="Copy API name" /></div><h2>{describe.data.value.label}</h2></div>
        <FavoriteButton kind="object" value={describe.data.value.name} defaultLabel={describe.data.value.label} />
        <NewRecordButton small objectApiName={describe.data.value.name} objectLabel={describe.data.value.label} createable={describe.data.value.createable} />
        <button class="btn small" onClick={() => ws.navigate({ tool: 'recordSearch', params: { objectApiName: describe.data!.value.name } })}><Icon name="search" /> Search records</button>
        <button class="btn small" onClick={() => ws.navigate({ tool: 'soql', params: { query: `SELECT Id FROM ${describe.data!.value.name} LIMIT 20` } })}><Icon name="code" /> Start SOQL</button>
        {ws.org && <a class="btn small" href={objectManagerUrl(ws.org, describe.data.value.name, 'FieldsAndRelationships')} target="_blank" rel="noopener noreferrer"><Icon name="external" /> Object Manager</a>}
      </div>
      <div class="row"><span class="pill">{describe.data.value.fields.length} fields</span><span class="pill">{describe.data.value.childRelationships.length} child relationships</span>{describe.data.value.custom && <span class="pill info">Custom</span>}</div>
      <div class="filter-bar">
        <SearchInput placeholder="Search label, API name, type, or relationship" label="Search fields" value={query} onValue={setQuery} />
        <select aria-label="Filter by field type" value={type} onChange={(e) => setType(e.currentTarget.value)}><option value="all">All field types</option>{types.map((t) => <option key={t} value={t}>{t}</option>)}</select>
        <select aria-label="Sort fields" value={sort} onChange={(e) => setSort(e.currentTarget.value as 'label' | 'name' | 'type')}><option value="label">Sort by label</option><option value="name">Sort by API name</option><option value="type">Sort by type</option></select>
        {(query || type !== 'all' || sort !== 'label') && <button class="btn small" onClick={() => { setQuery(''); setType('all'); setSort('label'); }}>Clear filters</button>}
      </div>
      <div class="table-wrap"><table><thead><tr><th>Label</th><th>API name</th><th>Type</th><th>Relationship</th><th>Access</th></tr></thead><tbody>{fields.map((f) => <tr key={f.name}><td>{f.label}</td><td><span class="row nowrap"><code>{f.name}</code><CopyButton value={f.name} label={`Copy ${f.name}`} /></span></td><td>{f.type}{f.length ? ` (${f.length})` : ''}</td><td>{f.referenceTo.length ? `${f.relationshipName ?? 'Lookup'} → ${f.referenceTo.join(', ')}` : '—'}</td><td>{f.createable ? 'Create' : ''}{f.createable && f.updateable ? ' · ' : ''}{f.updateable ? 'Update' : ''}{!f.createable && !f.updateable ? 'Read only' : ''}</td></tr>)}</tbody></table></div>
      {!fields.length && <p class="subtle">No fields match this search.</p>}
      <CacheInfo fetchedAt={describe.data.fetchedAt} fromCache={describe.data.fromCache} loading={describe.loading} onRefresh={() => setRefresh((n) => n + 1)} />
    </section>}
  </ConnectionGate>;
}
