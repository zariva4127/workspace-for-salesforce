import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ConnectionGate } from '../../components/ConnectionGate';
import { CopyButton } from '../../components/CopyButton';
import { SearchInput } from '../../components/SearchInput';
import { Alert, EmptyState, ErrorAlert, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useWorkspace } from '../../state/workspace';
import { orgBigStore } from '../../services/platform';
import { explainApex, explainFlow, explainTrigger, explanationText, flowPath, type AutomationItem, type AutomationKind, type LocalExplanation } from '../../../shared/development/codeExplainer';
import { isCancelled } from '../../../shared/api/errors';

type ToolingRow = Record<string, unknown> & { Id: string; Name?: string; MasterLabel?: string; FullName?: string; Status?: string; VersionNumber?: number; LastModifiedDate?: string; TableEnumOrId?: string; ProcessType?: string };
interface Loaded { item: AutomationItem; source: string; raw: unknown; explanation: LocalExplanation; fetchedAt: number }

const LABELS: Record<AutomationKind, string> = { class: 'Apex Classes', flow: 'Flows', trigger: 'Apex Triggers' };
const SINGULAR: Record<AutomationKind, string> = { class: 'Apex class', flow: 'Flow', trigger: 'Apex trigger' };
const LIST_QUERY: Record<AutomationKind, string> = {
  class: 'SELECT Id, Name, Status, ApiVersion, LastModifiedDate FROM ApexClass ORDER BY Name',
  trigger: 'SELECT Id, Name, Status, TableEnumOrId, ApiVersion, LastModifiedDate FROM ApexTrigger ORDER BY Name',
  flow: 'SELECT Id, MasterLabel, FullName, Status, VersionNumber, ProcessType, LastModifiedDate FROM Flow ORDER BY MasterLabel, VersionNumber DESC',
};

export function automationItems(kind: AutomationKind, rows: ToolingRow[]): AutomationItem[] {
  return rows.map((r) => ({
    id: r.Id, kind, name: String(r.Name ?? r.MasterLabel ?? r.FullName ?? r.Id),
    ...(r.Status ? { status: r.Status } : {}), ...(r.VersionNumber ? { version: Number(r.VersionNumber) } : {}),
    ...(r.LastModifiedDate ? { lastModified: r.LastModifiedDate } : {}), ...(r.TableEnumOrId ? { objectName: String(r.TableEnumOrId) } : {}),
    ...(r.ProcessType ? { processType: String(r.ProcessType) } : {}),
  }));
}

function Explorer({ kind }: { kind: AutomationKind }) {
  const ws = useWorkspace();
  const [items, setItems] = useState<AutomationItem[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [flowName, setFlowName] = useState('');
  const [query, setQuery] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<unknown>();
  const [loaded, setLoaded] = useState<Loaded>();
  const listAbort = useRef<AbortController>();
  const detailAbort = useRef<AbortController>();
  const store = useMemo(() => orgBigStore(ws.org!.key), [ws.org?.key]);

  const retrieve = async (item: AutomationItem, refresh = false) => {
    if (!ws.client) return;
    detailAbort.current?.abort(); const ctrl = new AbortController(); detailAbort.current = ctrl;
    const cacheKey = `code-explainer:${item.kind}:${item.id}:${item.lastModified ?? item.version ?? 'current'}`;
    setSelectedId(item.id); setLoadingDetail(true); setError(undefined);
    try {
      if (!refresh) {
        const cached = await store.get<Loaded>(cacheKey);
        if (cached) { setLoaded(cached); return; }
      }
      let source = ''; let raw: unknown;
      if (item.kind === 'flow') {
        const record = await ws.client.request<Record<string, unknown>>(`${ws.client.dataPath}/tooling/sobjects/Flow/${encodeURIComponent(item.id)}`, { signal: ctrl.signal });
        raw = record.Metadata ?? record;
      } else {
        const object = item.kind === 'class' ? 'ApexClass' : 'ApexTrigger';
        const record = await ws.client.request<Record<string, unknown>>(`${ws.client.dataPath}/tooling/sobjects/${object}/${encodeURIComponent(item.id)}`, { signal: ctrl.signal });
        source = String(record.Body ?? ''); raw = record;
      }
      const explanation = item.kind === 'flow' ? explainFlow(item, raw) : item.kind === 'trigger' ? explainTrigger(item, source) : explainApex(item, source);
      const result = { item, source, raw, explanation, fetchedAt: Date.now() };
      setLoaded(result); await store.set(cacheKey, result);
    } catch (e) { if (!isCancelled(e)) setError(e); }
    finally { if (!ctrl.signal.aborted) setLoadingDetail(false); }
  };

  const loadList = async () => {
    if (!ws.client) return;
    listAbort.current?.abort(); const ctrl = new AbortController(); listAbort.current = ctrl;
    setLoadingList(true); setError(undefined);
    try {
      const next = automationItems(kind, (await ws.client.query<ToolingRow>(LIST_QUERY[kind], { tooling: true, signal: ctrl.signal })).records);
      setItems(next);
      const requested = ws.route.params?.explorerName;
      const initial = requested ? next.find((x) => x.name.toLowerCase() === requested.toLowerCase()) : undefined;
      if (initial) { setFlowName(initial.name); void retrieve(initial); }
    } catch (e) { if (!isCancelled(e)) setError(e); }
    finally { if (!ctrl.signal.aborted) setLoadingList(false); }
  };
  useEffect(() => {
    setItems([]); setLoaded(undefined); setSelectedId(''); setFlowName(''); setQuery(''); void loadList();
    return () => { listAbort.current?.abort(); detailAbort.current?.abort(); };
  }, [kind, ws.client]);

  const names = useMemo(() => [...new Set(items.map((x) => x.name))], [items]);
  const filteredNames = names.filter((name) => {
    const matching = items.filter((x) => x.name === name);
    return !query.trim() || matching.some((x) => `${x.name} ${x.status ?? ''} ${x.processType ?? ''} ${x.objectName ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  });
  const versions = items.filter((x) => x.name === flowName).sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  const path = loaded?.item.kind === 'flow' ? flowPath(loaded.raw) : [];

  return <>
    <Alert kind="info" title="Private local analysis">Source and Flow metadata stay between this extension and your Salesforce org. Nothing is sent to an external AI service. Structural interpretations are labeled when uncertain.</Alert>
    <div class="explorer-layout">
      <aside class="card stack explorer-browser" aria-label={`${LABELS[kind]} browser`}>
        <div class="card-title"><div><span class="section-kicker">Org metadata</span><h2>{LABELS[kind]}</h2></div><button class="icon-btn" disabled={loadingList} onClick={() => void loadList()} aria-label={`Refresh ${LABELS[kind]}`} title="Refresh list"><Icon name="refresh" /></button></div>
        <SearchInput label={`Search ${LABELS[kind]}`} placeholder={`Search ${LABELS[kind]}`} value={query} onValue={setQuery} />
        <div class="explorer-count">{filteredNames.length} of {names.length}</div>
        {loadingList ? <Loading label={`Loading ${LABELS[kind]}…`} /> : filteredNames.length === 0 ? <p class="muted">{names.length === 0 ? `No ${LABELS[kind]} were returned for this org. Your user may not have access, or the org has none — use Refresh to try again.` : <>No {LABELS[kind]} match “{query}”. <button class="link-button" onClick={() => setQuery('')}>Clear search</button></>}</p> : <div class="explorer-list" role="listbox" aria-label={LABELS[kind]}>
          {filteredNames.map((name) => {
            const latest = items.find((x) => x.name === name)!;
            const selected = kind === 'flow' ? flowName === name : selectedId === latest.id;
            const versionCount = items.filter((x) => x.name === name).length;
            return <button role="option" aria-selected={selected} onClick={() => { setFlowName(name); if (kind !== 'flow') void retrieve(latest); }}>
              <strong class="ellipsis">{name}</strong>
              <span>{kind === 'flow' ? `${versionCount} version${versionCount === 1 ? '' : 's'} · ${latest.processType ?? 'Flow'}` : latest.objectName ?? latest.status ?? 'Available'}</span>
            </button>;
          })}
        </div>}
        {kind === 'flow' && flowName && <div class="field flow-version-picker"><label for="flow-version">Version</label><select id="flow-version" value={selectedId} onChange={(e) => { const item = versions.find((x) => x.id === e.currentTarget.value); if (item) void retrieve(item); }}><option value="">Select a version…</option>{versions.map((item) => <option value={item.id}>v{item.version ?? '?'} · {item.status ?? 'Unknown status'} · {item.processType ?? 'Flow'}</option>)}</select></div>}
      </aside>

      <div class="explorer-detail">
        {loadingDetail && <section class="card"><Loading label={`Retrieving ${SINGULAR[kind]}…`} /></section>}
        {error && <ErrorAlert error={error} onRetry={() => { const item = items.find((x) => x.id === selectedId); void (item ? retrieve(item, true) : loadList()); }} />}
        {!loaded && !loadingDetail && !error && <EmptyState title={`Select ${kind === 'flow' ? 'a Flow and version' : `an ${SINGULAR[kind]}`}`} icon="code"><p>Choose an accessible item to view its definition and local explanation.</p></EmptyState>}
        {loaded && !loadingDetail && <section class="card stack explorer-result">
          <div class="card-title"><div><span class="section-kicker">Local explanation</span><h2>{loaded.item.name}</h2><div class="row explorer-badges"><span class="pill info">{SINGULAR[loaded.item.kind]}</span>{loaded.item.status && <span class={`pill ${loaded.item.status === 'Active' ? 'ok' : 'unknown'}`}>{loaded.item.status}</span>}{loaded.item.version && <span class="pill">Version {loaded.item.version}</span>}{loaded.item.processType && <span class="pill">{loaded.item.processType}</span>}{loaded.item.objectName && <span class="pill">{loaded.item.objectName}</span>}</div></div><div class="row"><CopyButton value={explanationText(loaded.item, loaded.explanation)} label="Copy explanation" /><button class="btn small" onClick={() => void retrieve(loaded.item, true)}><Icon name="refresh" /> Refresh</button></div></div>
          <p class="explorer-summary">{loaded.explanation.summary}</p>
          {path.length > 0 && <div class="flow-path" aria-label="Flow path"><div class="section-label">Visual path</div><div class="flow-path-track"><span class="flow-node start">Start</span>{path.map((node) => <span class="flow-path-step"><span class="flow-arrow" aria-hidden="true">→</span><span class="flow-node"><strong>{node.name}</strong><small>{node.type}</small>{node.fault && <em>Fault → {node.fault}</em>}</span></span>)}</div></div>}
          <div class="explorer-sections">{loaded.explanation.sections.map((section, index) => <details open={index < 2}><summary>{section.title} {section.inferred && <span class="pill unknown">Uncertain</span>}</summary><p>{section.text}</p>{section.references.length > 0 && <div class="reference-list">{section.references.map((reference) => <code>{reference}</code>)}</div>}</details>)}</div>
          {loaded.explanation.dependencies.length > 0 && <div><h3>Identifiable dependencies</h3><div class="dependency-list">{loaded.explanation.dependencies.map((dependency) => loaded.item.kind === 'trigger' ? <button class="btn small" onClick={() => ws.navigate({ tool: 'apexClasses', params: { explorerName: dependency } })}><Icon name="link" /> {dependency}</button> : <code>{dependency}</code>)}</div></div>}
          <Alert kind="warning" title="Analysis limits">{loaded.explanation.limitations.join(' ')}</Alert>
          <details class="source-panel"><summary>{loaded.item.kind === 'flow' ? 'Retrieved Flow metadata' : 'Source code'}</summary><div class="source-toolbar"><span class="subtle">{(loaded.source || JSON.stringify(loaded.raw, null, 2)).split('\n').length.toLocaleString()} lines</span><CopyButton value={loaded.source || JSON.stringify(loaded.raw, null, 2)} label="Copy original definition" /></div><pre class="source-code">{loaded.source || JSON.stringify(loaded.raw, null, 2)}</pre></details>
        </section>}
      </div>
    </div>
  </>;
}

function ConnectedExplorer({ kind }: { kind: AutomationKind }) { return <ConnectionGate><Explorer kind={kind} /></ConnectionGate>; }
export function ApexClassesExplorer() { return <ConnectedExplorer kind="class" />; }
export function ApexTriggersExplorer() { return <ConnectedExplorer kind="trigger" />; }
export function FlowsExplorer() { return <ConnectedExplorer kind="flow" />; }
