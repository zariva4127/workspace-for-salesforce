/**
 * Home: where you are (org + page), where you left off, your saved items,
 * Setup shortcuts, and a compact org/user summary with details on demand.
 */
import { SearchInput } from '../../components/SearchInput';
import { useMemo, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { ConnectionScreen, NoOrgState, useConnState } from '../../components/ConnectionGate';
import { OrgBadge } from '../../components/OrgBadge';
import { CopyButton } from '../../components/CopyButton';
import { Alert, ErrorAlert, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { FavoriteModal } from '../../components/FavoriteControls';
import { useAsync } from '../../hooks/useAsync';
import { useFavorites } from '../../hooks/useFavorites';
import { loadOrgInfo } from '../../../shared/salesforce/orgInfo';
import { objectManagerUrl, recordUrl, setupLinks } from '../../../shared/salesforce/links';
import { ENVIRONMENT_LABELS } from '../../../shared/org/identity';
import { effectiveEnvironment } from '../../../shared/org/profiles';
import { PAGE_TYPE_LABELS } from '../../../shared/context/pageContext';
import { groupFavorites, type Favorite, type FavoriteKind } from '../../../shared/workspace/favorites';
import { toolMeta } from '../../state/routes';
import { profiles } from '../../services/platform';
import { ACTIVITY_KEY, type ActivityItem } from '../../../shared/workspace/activity';

function ContextCard() {
  const ws = useWorkspace();
  const org = ws.org!;
  const env = effectiveEnvironment(org);
  const page = ws.orgMatchesTab ? ws.page : null;
  return (
    <section class="card stack home-hero" aria-labelledby="ctx-h">
      <h2 id="ctx-h" class="visually-hidden">
        Where you are
      </h2>
      <div class="home-hero-heading">
        <div class="stack home-hero-copy">
          <span class="home-eyebrow">Current workspace</span>
          <div class="row">
            <OrgBadge org={org} large />
            <span class="subtle">
              {ENVIRONMENT_LABELS[env]}
              {org.environmentOverride ? ' (set manually)' : org.orgId ? '' : ' (connect to confirm)'}
            </span>
          </div>
        </div>
        {page && <span class="context-pill"><Icon name={page.recordId ? 'record' : 'external'} /> {PAGE_TYPE_LABELS[page.pageType]}{page.objectApiName ? ` · ${page.objectApiName}` : ''}</span>}
      </div>
      {env === 'production' && <Alert kind="warning">You're in a production org. Changes you make in Salesforce affect real users and data.</Alert>}
      {page ? (
        <div class="home-hero-actions">
          <span class="muted">Continue working with the context from your Salesforce tab.</span>
          <span class="grow" />
          {page.recordId && (
            <button class="btn primary small" onClick={() => ws.navigate({ tool: 'record' })}>
              <Icon name="record" /> Record details
            </button>
          )}
          {page.objectApiName && (
            <button class="btn small" onClick={() => ws.navigate({ tool: 'objects', params: { objectApiName: page.objectApiName! } })}>
              <Icon name="database" /> Object details
            </button>
          )}
        </div>
      ) : (
        <p class="subtle">The Salesforce tab isn't showing this org right now.</p>
      )}
      {ws.recentTools.length > 0 && (
        <div class="stack jump-back">
          <span class="section-label">Jump back in</span>
          <div class="recent-tools">
            {ws.recentTools.map((t) => (
              <button key={t} class="btn small" onClick={() => ws.navigate({ tool: t })}>
                {toolMeta(t).label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const KIND_META: Record<FavoriteKind, { title: string; empty: string }> = {
  object: { title: 'Objects', empty: 'Use Save on an object in Objects & fields.' },
  record: { title: 'Records', empty: 'Use Save on any record in Record details.' },
  query: { title: 'Queries', empty: 'Use Save in the SOQL workspace.' },
};

function SavedItems() {
  const ws = useWorkspace();
  const favs = useFavorites();
  const [renaming, setRenaming] = useState<Favorite | null>(null);
  const [filter, setFilter] = useState('');
  const groups = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return groupFavorites(favs.list.filter((f) => !t || `${f.label} ${f.value} ${f.objectApiName ?? ''}`.toLowerCase().includes(t)));
  }, [favs.list, filter]);

  const open = (f: Favorite) => {
    if (f.kind === 'object') ws.navigate({ tool: 'objects', params: { objectApiName: f.value } });
    else if (f.kind === 'record') ws.navigate({ tool: 'record', params: { recordId: f.value } });
    else ws.navigate({ tool: 'soql', params: { query: f.value } });
  };

  return (
    <section class="card stack home-saved" aria-labelledby="saved-h">
      <div class="card-title">
        <div><span class="section-kicker">Pinned for this org</span><h2 id="saved-h">Your workspace</h2></div>
        {favs.list.length > 5 && <SearchInput style={{ maxWidth: 220 }} placeholder="Filter saved items" label="Filter saved items" value={filter} onValue={setFilter} />}
      </div>
      {favs.list.length === 0 ? (
        <div class="empty-inline">
          <span class="empty-inline-icon"><Icon name="star" /></span>
          <div class="grow"><strong>Keep frequent work close</strong><p class="muted">Save records, objects, and queries to build an org-specific workspace.</p></div>
          <div class="row">
            <button class="btn small" onClick={() => ws.navigate({ tool: 'recordSearch' })}>
              <Icon name="search" /> Find a record
            </button>
            <button class="btn small" onClick={() => ws.navigate({ tool: 'objects' })}>
              <Icon name="database" /> Browse objects
            </button>
          </div>
        </div>
      ) : (
        <div class="grid-2">
          {(Object.keys(KIND_META) as FavoriteKind[]).map((kind) => (
            <div key={kind} class="stack" style={{ gap: 2 }}>
              <span class="section-label">
                {KIND_META[kind].title} ({groups[kind].length})
              </span>
              {groups[kind].length === 0 ? (
                <p class="subtle">{filter ? 'No matches.' : KIND_META[kind].empty}</p>
              ) : (
                <ul class="result-list">
                  {groups[kind].map((f) => (
                    <li key={f.id}>
                      <button class="result-main" onClick={() => open(f)} title={f.kind === 'query' ? f.value : undefined}>
                        <strong>{f.label}</strong>
                        <span>{f.kind === 'record' ? (f.objectApiName ?? f.value) : f.value.replace(/\s+/g, ' ')}</span>
                      </button>
                      {f.kind === 'record' && ws.org && (
                        <a class="icon-btn" href={recordUrl(ws.org, f.objectApiName, f.value)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${f.label} in Salesforce`} title="Open in Salesforce">
                          <Icon name="external" />
                        </a>
                      )}
                      <button class="icon-btn" aria-label={`Rename ${f.label}`} title="Rename" onClick={() => setRenaming(f)}>
                        <Icon name="edit" />
                      </button>
                      <button class="icon-btn" aria-label={`Remove ${f.label}`} title="Remove" onClick={() => void favs.remove(f)}>
                        <Icon name="trash" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      {renaming && (
        <FavoriteModal open kind={renaming.kind} editing={renaming} initialLabel={renaming.label} onClose={() => setRenaming(null)} onSave={(label) => favs.rename(renaming.id, label)} />
      )}
    </section>
  );
}

function SetupShortcuts() {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const links = setupLinks(ws.org!);
  const obj = ws.orgMatchesTab ? ws.page.objectApiName : undefined;
  const items: Array<[string, string]> = [
    ['Setup home', links.setup],
    ['Object Manager', links.objectManager],
    ['Users', links.users],
    ['Profiles', links.profiles],
    ['Permission sets', links.permissionSets],
    ['Sharing settings', links.sharingSettings],
    ['Flows', links.flows],
    ['Paused & failed flows', links.pausedFlows],
    ['Debug logs', links.debugLogs],
    ['Apex jobs', links.apexJobs],
    ['Deployment status', links.deploymentStatus],
    ['Company information', links.companyInfo],
  ];
  const t = q.trim().toLowerCase();
  const shown = items.filter(([label]) => !t || label.toLowerCase().includes(t));
  const objectLinks = [
    ['Fields & relationships', 'FieldsAndRelationships'],
    ['Page layouts', 'PageLayouts'],
    ['Record types', 'RecordTypes'],
    ['Validation rules', 'ValidationRules'],
  ] as const;
  return (
    <section class="card stack home-shortcuts" aria-labelledby="links-h">
      <div class="card-title">
        <div><span class="section-kicker">Open in Salesforce</span><h2 id="links-h">Setup shortcuts</h2></div>
        <SearchInput style={{ maxWidth: 180 }} placeholder="Filter" label="Filter Setup shortcuts" value={q} onValue={setQ} />
      </div>
      {obj && !t && (
        <>
          <span class="section-label">{obj} in Object Manager</span>
          <div class="link-grid">
            {objectLinks.map(([label, section]) => (
              <a key={section} href={objectManagerUrl(ws.org!, obj, section)} target="_blank" rel="noopener noreferrer">
                <Icon name="external" />
                {label}
              </a>
            ))}
          </div>
          <span class="section-label">Org Setup</span>
        </>
      )}
      {shown.length === 0 ? (
        <p class="subtle">No shortcuts match “{q}”.</p>
      ) : (
        <div class="link-grid">
          {shown.map(([label, href]) => (
            <a key={label} href={href} target="_blank" rel="noopener noreferrer">
              <Icon name="external" />
              {label}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function OrgSummary() {
  const ws = useWorkspace();
  const { data, error, loading, run } = useAsync(ws.client && ws.session ? (signal) => loadOrgInfo(ws.client!, ws.session!.userId, signal) : null, [ws.client, ws.session?.userId]);
  if (loading && !data) return <Loading label="Loading org and user details…" />;
  if (error) return <ErrorAlert error={error} onRetry={run} />;
  if (!data) return null;
  const o = data.organization;
  const u = data.user;
  const api = data.apiRequests;
  const used = api ? api.max - api.remaining : 0;
  const ratio = api && api.max ? used / api.max : 0;
  return (
    <section class="card stack home-org" aria-labelledby="org-sum-h">
      <div class="card-title">
        <div><span class="section-kicker">At a glance</span><h2 id="org-sum-h">Org & user</h2></div>
        <button class="btn small" onClick={run} disabled={loading}>
          <Icon name="refresh" /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <dl class="kv">
        <dt>Org</dt>
        <dd>{o ? `${o.Name} · ${o.OrganizationType}${o.IsSandbox ? ' (sandbox)' : ''}` : 'Not visible to your user'}</dd>
        <dt>You</dt>
        <dd>{u ? `${u.Name} · ${u.Profile?.Name ?? 'No profile visible'}${u.UserRole?.Name ? ` · ${u.UserRole.Name}` : ''}` : 'Unavailable'}</dd>
        {o?.TrialExpirationDate && (
          <>
            <dt>Expires</dt>
            <dd>{new Date(o.TrialExpirationDate).toLocaleDateString()}</dd>
          </>
        )}
      </dl>
      {api ? (
        <div class="stack" style={{ gap: 4 }}>
          <div class="row">
            <span class="grow">API requests today</span>
            <span class="subtle">
              {used.toLocaleString()} of {api.max.toLocaleString()}
            </span>
          </div>
          <div class={`meter ${ratio > 0.9 ? 'high' : ratio > 0.7 ? 'warn' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={api.max} aria-valuenow={used} aria-label="API requests used today">
            <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
          </div>
        </div>
      ) : null}
      <details class="subtle-details">
        <summary>More details</summary>
        <dl class="kv">
          {o && (
            <>
              <dt>Org ID</dt>
              <dd class="row nowrap">
                <code>{o.Id}</code>
                <CopyButton value={o.Id} label="Copy org ID" />
              </dd>
              <dt>Instance</dt>
              <dd>{o.InstanceName}</dd>
              {o.NamespacePrefix && (
                <>
                  <dt>Namespace</dt>
                  <dd>{o.NamespacePrefix}</dd>
                </>
              )}
            </>
          )}
          {u && (
            <>
              <dt>Username</dt>
              <dd class="break">{u.Username}</dd>
              <dt>User ID</dt>
              <dd class="row nowrap">
                <code>{u.Id}</code>
                <CopyButton value={u.Id} label="Copy user ID" />
              </dd>
              <dt>Locale</dt>
              <dd>
                {u.LanguageLocaleKey} · {u.TimeZoneSidKey}
              </dd>
            </>
          )}
          <dt>API version</dt>
          <dd>
            v{ws.client?.apiVersion}
            {data.latestApiVersion && data.latestApiVersion !== ws.client?.apiVersion ? ` (latest ${data.latestApiVersion})` : ''}
          </dd>
          <dt>My Domain</dt>
          <dd class="mono break">{ws.org!.apiHost}</dd>
        </dl>
        {!api && <p class="subtle">API usage needs the "View Setup and Configuration" permission.</p>}
      </details>
      {data.errors.length > 0 && (
        <Alert kind="warning" title="Some details aren't available to your user">
          <ul class="plain">
            {data.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Alert>
      )}
    </section>
  );
}

function Activity() {
  const ws = useWorkspace();
  const store = useMemo(() => profiles.scoped(ws.org!.key), [ws.org?.key]);
  const activity = useAsync((signal) => store.get<ActivityItem[]>(ACTIVITY_KEY).then((items) => { if (signal.aborted) return []; return items ?? []; }), [store, ws.dataVersion]);
  const items = activity.data ?? [];
  return <section class="card stack home-activity" aria-labelledby="activity-h">
    <div class="card-title"><div><span class="section-kicker">Recent changes</span><h2 id="activity-h">Activity</h2></div>{items.length > 0 && <button class="btn small ghost" onClick={async () => { await store.remove(ACTIVITY_KEY); activity.run(); }}>Clear</button>}</div>
    {activity.loading && !activity.data ? <Loading label="Loading activity…" /> : items.length === 0 ? <div class="empty-inline compact"><span class="empty-inline-icon"><Icon name="check" /></span><div><strong>Nothing to review</strong><p class="muted">Record changes and exports started here will appear in this private, org-specific log.</p></div></div> : <ul class="list compact">{items.slice(0, 10).map((item) => <li key={item.id}><span class={`status-dot ${item.status === 'success' ? 'connected' : 'expired'}`} /><div class="grow"><strong>{item.action}</strong><div class="subtle">{new Date(item.time).toLocaleString()}{item.detail ? ` · ${item.detail}` : ''}</div></div><span class={`pill ${item.status === 'success' ? 'ok' : 'error'}`}>{item.status}</span></li>)}</ul>}
  </section>;
}

export function Overview() {
  const ws = useWorkspace();
  const conn = useConnState();
  if (ws.tab.loading) return <Loading label="Looking at the Salesforce tab…" />;
  if (!ws.org) return <NoOrgState />;
  const connected = conn === 'connected';
  return (
    <div class="home-dashboard">
      <ContextCard />
      {!connected && conn !== 'checking' && <ConnectionScreen />}
      <SavedItems />
      <div class="home-grid">
        <SetupShortcuts />
        {connected && <OrgSummary />}
      </div>
      <Activity />
    </div>
  );
}
