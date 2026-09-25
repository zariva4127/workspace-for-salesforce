/**
 * Record details: key fields, parent lookups, related lists, and all fields for
 * the record in the active tab (or one opened from search / saved items).
 * Data comes from the REST API as the connected user, so field-level security
 * and sharing apply.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { ConnectionGate } from '../../components/ConnectionGate';
import { CopyButton } from '../../components/CopyButton';
import { Alert, EmptyState, ErrorAlert, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { FavoriteButton } from '../../components/FavoriteControls';
import { SearchInput } from '../../components/SearchInput';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toasts';
import { useAsync } from '../../hooks/useAsync';
import { useFavorites } from '../../hooks/useFavorites';
import { RecordForm, discardStoredDraft, hasStoredDraft } from './RecordForm';
import { NewRecordButton } from './NewRecordButton';
import { displayValue, keyFields, listChildren, loadRecord, myRecordAccess, type LoadedRecord } from '../../../shared/salesforce/records';
import { FieldValue } from './FieldValue';
import { displayText } from '../../../shared/records/fieldDisplay';
import { filterSections, sectionsFromLayout, sectionsFromMetadata, type FieldSection } from '../../../shared/records/layout';
import { isSystemRelationship, type ChildRelationshipInfo, type FieldInfo } from '../../../shared/salesforce/metadata';
import { objectManagerUrl, recordUrl, relatedListUrl } from '../../../shared/salesforce/links';
import { explainError, isCancelled } from '../../../shared/api/errors';
import { recordActions } from '../../../shared/records/recordEdit';
import { effectiveEnvironment } from '../../../shared/org/profiles';

type Tab = 'details' | 'related';

function ChildRow({ rel, parent, createable }: { rel: ChildRelationshipInfo; parent: { id: string; name: string; objectApiName: string }; createable?: boolean }) {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const list = useAsync(
    open && ws.client && ws.metadata ? (signal) => listChildren(ws.client!, ws.metadata!, rel.childSObject, rel.field, parent.id, signal) : null,
    [open, ws.client, ws.dataVersion],
  );
  const title = rel.relationshipName ?? rel.childSObject;
  return (
    <li class="stack" style={{ alignItems: 'stretch', gap: 4 }}>
      <div class="row nowrap">
        <button type="button" class="icon-btn" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} ${title}`} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'back' : 'chevron'} class={open ? 'rot-down' : ''} />
        </button>
        <div class="grow">
          <button type="button" class="link-button" style={{ textDecoration: 'none', fontWeight: 700, color: 'var(--text)' }} onClick={() => setOpen(!open)}>
            {title}
          </button>
          <div class="subtle">
            {rel.childSObject} · via {rel.field}
            {open && list.data ? ` · ${list.data.total.toLocaleString()} record${list.data.total === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <NewRecordButton
          small
          label="New"
          objectApiName={rel.childSObject}
          {...(createable !== undefined ? { createable } : {})}
          prefill={{ [rel.field]: parent.id }}
          prefillNames={{ [rel.field]: parent.name }}
          openAfterCreate={false}
        />
        {rel.relationshipName && (
          <a class="icon-btn" href={relatedListUrl(ws.org!, parent.objectApiName, parent.id, rel.relationshipName)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${rel.relationshipName} related list in Salesforce`} title="Open related list in Salesforce">
            <Icon name="external" />
          </a>
        )}
      </div>
      {open && (
        <div class="child-records">
          {list.loading ? (
            <Loading label="Loading records…" />
          ) : list.error ? (
            <ErrorAlert error={list.error} onRetry={list.run} />
          ) : list.data && list.data.records.length === 0 ? (
            <p class="subtle">No {title.toLowerCase()} you can see.</p>
          ) : (
            <ul class="result-list">
              {list.data?.records.map((c) => (
                <li key={c.id}>
                  <button class="result-main" onClick={() => ws.navigate({ tool: 'record', params: { recordId: c.id } })}>
                    <strong>{c.name}</strong>
                    <span>{c.objectApiName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.data && list.data.total > list.data.records.length && <p class="subtle">Showing the 10 newest of {list.data.total.toLocaleString()}. Open the related list in Salesforce to see all.</p>}
        </div>
      )}
    </li>
  );
}

type LayoutState = { sections: FieldSection[]; source: 'layout' | 'metadata'; currency?: string };

/** All readable fields, grouped by the user's page layout (or logically when no layout is available). */
function DetailsTab({ rec }: { rec: LoadedRecord }) {
  const ws = useWorkspace();
  const d = rec.describe;
  const recordTypeId = typeof rec.values.RecordTypeId === 'string' ? rec.values.RecordTypeId : undefined;
  const layout = useAsync<LayoutState>(
    ws.metadata
      ? async (signal) => {
          const [lay, currency] = await Promise.all([
            ws.metadata!.layout(d.name, recordTypeId, { signal }).catch((e) => (isCancelled(e) ? Promise.reject(e) : undefined)),
            typeof rec.values.CurrencyIsoCode === 'string' ? Promise.resolve(rec.values.CurrencyIsoCode) : ws.metadata!.orgCurrency({ signal }).catch(() => undefined),
          ]);
          return lay
            ? { sections: sectionsFromLayout(lay, d.fields, rec.values), source: 'layout' as const, ...(currency ? { currency } : {}) }
            : { sections: sectionsFromMetadata(d.fields, rec.values), source: 'metadata' as const, ...(currency ? { currency } : {}) };
        }
      : null,
    [rec, ws.metadata],
  );
  const [q, setQ] = useState('');
  const [hideEmpty, setHideEmpty] = useState(true);
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  const lookups = useMemo(() => new Map(rec.lookups.map((l) => [l.field.name, l])), [rec]);

  if (layout.loading && !layout.data) return <Loading label="Arranging fields…" />;
  const data = layout.data ?? { sections: sectionsFromMetadata(d.fields, rec.values), source: 'metadata' as const };
  const ctx = { ...(data.currency ? { currency: data.currency } : {}) };
  const show = (f: FieldInfo) => (f.type === 'reference' ? (lookups.get(f.name)?.name ?? displayValue(rec.values[f.name])) : displayText(f, rec.values[f.name], ctx));
  const shown = filterSections(data.sections, q, show, hideEmpty);
  const total = data.sections.reduce((n, s) => n + s.fields.length, 0);
  const searching = q.trim() !== '';
  const isOpen = (s: FieldSection) => (searching ? true : (openState[s.id] ?? !s.collapsed));
  const allOpen = data.sections.every(isOpen);

  return (
    <section class="card stack record-fields" aria-labelledby="rd-fields">
      <div class="card-title">
        <div><span class="section-kicker">Record data</span><h2 id="rd-fields">Fields</h2></div>
        <span class="subtle record-field-count">
          {data.source === 'layout' ? 'Grouped by your page layout' : 'Page layout unavailable — grouped by field type'} · {total} readable field{total === 1 ? '' : 's'}
        </span>
      </div>
      <div class="filter-bar">
        <SearchInput placeholder="Search fields by label, API name, or value" label="Search fields" value={q} onValue={setQ} />
        <label class="check">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.currentTarget.checked)} /> Hide empty fields
        </label>
        <button
          type="button"
          class="btn small"
          disabled={searching}
          onClick={() => setOpenState(Object.fromEntries(data.sections.map((s) => [s.id, !allOpen])))}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      {shown.length === 0 ? (
        <p class="muted">
          {searching ? `No fields match “${q}”.` : 'All fields are empty.'}{' '}
          {(searching || hideEmpty) && (
            <button
              type="button"
              class="link-button"
              onClick={() => {
                setQ('');
                setHideEmpty(false);
              }}
            >
              Clear filters
            </button>
          )}
        </p>
      ) : (
        shown.map((sec) => {
          const full = data.sections.find((x) => x.id === sec.id)!;
          const empty = full.fields.filter((f) => !show(f)).length;
          return (
            <details
              key={sec.id}
              class="field-section"
              open={isOpen(sec)}
              onToggle={(e) => {
                const open = (e.currentTarget as HTMLDetailsElement).open;
                if (!searching && open !== isOpen(sec)) setOpenState((st) => ({ ...st, [sec.id]: open }));
              }}
            >
              <summary>
                <span class="grow">{sec.title}</span>
                <span class="subtle">
                  {searching ? `${sec.fields.length} match${sec.fields.length === 1 ? '' : 'es'}` : `${full.fields.length} field${full.fields.length === 1 ? '' : 's'}${empty ? ` · ${empty} empty` : ''}`}
                </span>
              </summary>
              <dl class="field-grid">
                {sec.fields.map((f) => {
                  const raw = rec.values[f.name];
                  const copy = displayValue(raw);
                  return (
                    <div key={f.name} class="field-item">
                      <dt title={`${f.name} · ${f.type}`}>{f.label}</dt>
                      <dd>
                        <FieldValue field={f} value={raw} {...(lookups.get(f.name) ? { lookup: lookups.get(f.name)! } : {})} ctx={ctx} />
                        {copy && f.type !== 'boolean' && <CopyButton value={copy} label={`Copy ${f.label}`} />}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </details>
          );
        })
      )}
      {rec.hiddenFieldCount > 0 && <p class="subtle">{rec.hiddenFieldCount} more field(s) on {d.label} aren't visible to you (field-level security).</p>}
    </section>
  );
}

function LinkedRecords({ rec }: { rec: LoadedRecord }) {
  const ws = useWorkspace();
  return (
    <section class="card" aria-labelledby="rd-parents">
      <h2 id="rd-parents">Linked records ({rec.lookups.length})</h2>
      {rec.lookups.length === 0 ? (
        <p class="muted">No lookup fields are filled in (or you can't see them).</p>
      ) : (
        <ul class="result-list">
          {rec.lookups.map((l) => (
            <li key={l.field.name}>
              <button class="result-main" onClick={() => ws.navigate({ tool: 'record', params: { recordId: l.id } })}>
                <strong>{l.name ?? l.id}</strong>
                <span>
                  {l.field.label} · {l.objectApiName ?? l.field.referenceTo.join(' / ')}
                </span>
              </button>
              <CopyButton value={l.id} label={`Copy ${l.field.label} ID`} />
              <a class="icon-btn" href={recordUrl(ws.org!, l.objectApiName, l.id)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${l.field.label} in Salesforce`} title="Open in Salesforce">
                <Icon name="external" />
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RelatedTab({ rec, id }: { rec: LoadedRecord; id: string }) {
  const ws = useWorkspace();
  const [q, setQ] = useState('');
  const [queryable, setQueryable] = useState<Set<string> | null>(null);
  const [createable, setCreateable] = useState<Set<string>>(new Set());
  const recordTypeId = typeof rec.values.RecordTypeId === 'string' ? rec.values.RecordTypeId : undefined;
  const layout = useAsync(
    ws.metadata ? (signal) => ws.metadata!.layout(rec.describe.name, recordTypeId, { signal }) : null,
    [ws.metadata, rec.describe.name, recordTypeId],
  );

  useEffect(() => {
    const ctrl = new AbortController();
    ws.metadata?.objects({ signal: ctrl.signal }).then(
      (r) => {
        setQueryable(new Set(r.value.filter((o) => o.queryable).map((o) => o.name)));
        setCreateable(new Set(r.value.filter((o) => o.createable).map((o) => o.name)));
      },
      () => setQueryable(new Set()),
    );
    return () => ctrl.abort();
  }, [ws.metadata]);

  const layoutLists = useMemo(() => new Set((layout.data?.relatedLists ?? []).map((name) => name.toLowerCase())), [layout.data]);
  const layoutOrder = useMemo(() => new Map((layout.data?.relatedLists ?? []).map((name, index) => [name.toLowerCase(), index])), [layout.data]);
  const all = useMemo(
    () => rec.describe.childRelationships.filter((c) => c.relationshipName && layoutLists.has(c.relationshipName.toLowerCase()) && (!queryable || queryable.has(c.childSObject))),
    [rec, queryable, layoutLists],
  );
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return all
      .filter((c) => !t || `${c.childSObject} ${c.relationshipName} ${c.field}`.toLowerCase().includes(t))
      .sort((a, b) => (layoutOrder.get((a.relationshipName ?? '').toLowerCase()) ?? 0) - (layoutOrder.get((b.relationshipName ?? '').toLowerCase()) ?? 0));
  }, [all, q, layoutOrder]);

  if (queryable === null || layout.loading) return <Loading label="Loading related lists from your page layout…" />;
  if (layout.error || !layout.data) {
    return <Alert kind="warning" title="Related lists unavailable">Salesforce didn't return the assigned page layout. No unrelated child relationships are shown.</Alert>;
  }
  return (
    <section class="card stack" aria-labelledby="rd-rel">
      <h2 id="rd-rel">Related lists ({shown.length})</h2>
      <div class="filter-bar">
        <SearchInput placeholder="Filter related lists" label="Filter related lists" value={q} onValue={setQ} />
      </div>
      {shown.length === 0 ? (
        <p class="muted">{q ? 'No related lists match this filter.' : 'This page layout has no related lists you can query.'}</p>
      ) : (
        <ul class="list">
          {shown.map((c) => (
            <ChildRow key={`${c.childSObject}.${c.field}`} rel={c} parent={{ id, name: rec.nameValue ?? id, objectApiName: rec.describe.name }} createable={createable.has(c.childSObject)} />
          ))}
        </ul>
      )}
      <p class="subtle">Only lists on your assigned Salesforce page layout are shown. Record sharing and object permissions still apply.</p>
    </section>
  );
}

/** Key information under the record name, from the object's compact layout (the Salesforce "highlights" fields). */
function Highlights({ rec }: { rec: LoadedRecord }) {
  const ws = useWorkspace();
  const d = rec.describe;
  const compact = useAsync(
    ws.metadata
      ? async (signal) => {
          const [fields, currency] = await Promise.all([
            ws.metadata!.compactFields(d.name, { signal }).catch(() => [] as string[]),
            typeof rec.values.CurrencyIsoCode === 'string' ? Promise.resolve(rec.values.CurrencyIsoCode) : ws.metadata!.orgCurrency({ signal }).catch(() => undefined),
          ]);
          return { fields, currency };
        }
      : null,
    [d.name, ws.metadata],
  );
  const lookups = new Map(rec.lookups.map((l) => [l.field.name, l]));
  if (compact.loading && !compact.data) return <div class="highlights" aria-busy="true"><div class="skeleton" /></div>;
  const names = (compact.data?.fields.length ? compact.data.fields : keyFields(d).map((f) => f.name)).filter((n) => n !== 'Id' && !d.fields.find((f) => f.name === n)?.nameField);
  const fields = names
    .map((n) => d.fields.find((f) => f.name === n))
    .filter((f): f is FieldInfo => !!f && f.name in rec.values)
    .slice(0, 6);
  if (!fields.length) return null;
  return (
    <dl class="highlights">
      {fields.map((f) => (
        <div key={f.name}>
          <dt>{f.label}</dt>
          <dd>
            <FieldValue field={f} value={rec.values[f.name]} {...(lookups.get(f.name) ? { lookup: lookups.get(f.name)! } : {})} ctx={compact.data?.currency ? { currency: compact.data.currency } : {}} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RecordView({ rec, onChanged, onDeleted }: { rec: LoadedRecord; onChanged: () => void; onDeleted: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const favs = useFavorites();
  const [confirm, confirmEl] = useConfirm();
  const [tab, setTab] = useState<Tab>('details');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const id = String(rec.values.Id ?? '');
  const d = rec.describe;
  const title = rec.nameValue ?? id;
  const orgKey = ws.org!.key;
  const [pendingDraft, setPendingDraft] = useState(() => hasStoredDraft(orgKey, 'edit', id));

  const access = useAsync(ws.client && ws.session ? (signal) => myRecordAccess(ws.client!, ws.session!.userId, id, signal) : null, [id, ws.client, ws.dataVersion]);
  // Until the live access check finishes, actions stay disabled (no flash of enabled buttons).
  const accessPending = access.loading || (access.data === undefined && !access.error);
  const actions = recordActions(d, access.data ?? undefined, { changesEnabled: ws.settings.allowRecordChanges });
  const prod = effectiveEnvironment(ws.org!) === 'production';

  const doDelete = async (withCheck: boolean): Promise<void> => {
    setDeleting(true);
    try {
      const last = rec.values.LastModifiedDate as string | undefined;
      await ws.client!.deleteRecord(d.name, id, withCheck && last ? { ifUnmodifiedSince: last } : {});
      await favs.forgetRecord(id);
      discardStoredDraft(orgKey, 'edit', id);
      ws.notifyRecordChange({ type: 'deleted', id, objectApiName: d.name });
      toast({
        message: `Deleted ${d.label} “${title}”. It's in the Salesforce Recycle Bin if you need it back.`,
        duration: 8000,
        action: { label: 'Recycle Bin', onClick: () => window.open(`https://${ws.org!.lightningHost}/lightning/o/DeleteEvent/home`, '_blank', 'noopener') },
      });
      onDeleted();
    } catch (e) {
      const ex = explainError(e);
      if (ex.kind === 'conflict') {
        const again = await confirm({
          title: 'This record changed since you opened it',
          body: `Someone updated “${title}” after you loaded it. Delete it anyway?`,
          confirmLabel: 'Delete anyway',
          danger: true,
        });
        if (again) return doDelete(false);
      } else if (ex.kind === 'notFound') {
        toast({ kind: 'info', message: `“${title}” was already deleted.` });
        ws.notifyRecordChange({ type: 'deleted', id, objectApiName: d.name });
        onDeleted();
      } else {
        toast({ kind: 'error', message: `Couldn't delete: ${ex.detail}${ex.action ? ` ${ex.action}` : ''}`, duration: 10000 });
      }
    } finally {
      setDeleting(false);
    }
  };

  const askDelete = async () => {
    const cascade = d.childRelationships.filter((c) => c.cascadeDelete && c.relationshipName && !isSystemRelationship(c.childSObject)).map((c) => c.relationshipName!);
    const ok = await confirm({
      title: `Delete this ${d.label}?`,
      body: (
        <div class="stack">
          <dl class="kv">
            <dt>Name</dt>
            <dd>
              <strong>{title}</strong>
            </dd>
            <dt>Object</dt>
            <dd>{d.label}</dd>
            <dt>Record ID</dt>
            <dd class="mono">{id}</dd>
            <dt>Org</dt>
            <dd>{ws.org!.label ?? ws.org!.orgName ?? ws.org!.myDomain}</dd>
          </dl>
          {cascade.length > 0 && <div class="alert warning">Related records may be deleted with it: {cascade.slice(0, 6).join(', ')}{cascade.length > 6 ? '…' : ''}.</div>}
          <p class="muted" style={{ margin: 0 }}>It moves to the Salesforce Recycle Bin, where it can be restored for a limited time.</p>
        </div>
      ),
      confirmLabel: `Delete ${d.label}`,
      danger: true,
      ...(prod ? { typeToConfirm: 'DELETE' } : {}),
    });
    if (ok) await doDelete(true);
  };
  const tabs: Array<[Tab, string]> = [
    ['details', 'Details'],
    ['related', `Related (${rec.lookups.length} linked)`],
  ];
  const blocked = [
    actions.edit.allowed ? null : `Edit: ${actions.edit.reason}`,
    actions.create.allowed ? null : `New: ${actions.create.reason}`,
    actions.delete.allowed ? null : `Delete: ${actions.delete.reason}`,
  ].filter(Boolean);
  // When every action is off for the same reason (e.g. the Settings switch), say it once.
  const blockedNote = new Set(blocked.map((b) => b!.replace(/^\w+: /, ''))).size === 1 && blocked.length === 3 ? [blocked[0]!.replace(/^\w+: /, '')] : blocked;
  return (
    <>
      {confirmEl}
      {pendingDraft && actions.edit.allowed && (
        <div class="alert info row" role="status">
          <span class="grow">You have unsaved changes to this record from earlier (for example, before your session ended).</span>
          <button class="btn small primary" onClick={() => setEditing(true)}>
            Continue editing
          </button>
          <button
            class="btn small"
            onClick={() => {
              discardStoredDraft(orgKey, 'edit', id);
              setPendingDraft(false);
            }}
          >
            Discard
          </button>
        </div>
      )}
      <section class="card stack record-hero" aria-labelledby="rec-h">
        <div class="record-head record-hero-head">
          <span class="record-object-icon" aria-hidden="true"><Icon name="record" /></span>
          <div class="grow record-title">
            <div class="section-kicker">{d.label}</div>
            <h2 id="rec-h" class="break">{title}</h2>
            <span class="subtle mono">{d.name}</span>
          </div>
          <div class="record-hero-tools"><FavoriteButton kind="record" value={id} defaultLabel={title} objectApiName={d.name} /></div>
        </div>
        <Highlights rec={rec} />
        <div class="record-actions" role="group" aria-label="Record actions">
          <button class="btn primary" onClick={() => setEditing(true)} disabled={!actions.edit.allowed || accessPending} title={actions.edit.reason ?? 'Edit this record'}>
            <Icon name="edit" /> Edit
          </button>
          <NewRecordButton objectApiName={d.name} objectLabel={d.label} createable={actions.create.allowed ? true : d.createable ? undefined : false} />
          <a class="btn" href={recordUrl(ws.org!, d.name, id)} target="_blank" rel="noopener noreferrer">
            <Icon name="external" /> Open in Salesforce
          </a>
          <span class="grow" />
          <button class="btn danger" onClick={() => void askDelete()} disabled={!actions.delete.allowed || deleting || accessPending} title={actions.delete.reason ?? `Delete this ${d.label}`}>
            <Icon name="trash" /> {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
        {accessPending ? (
          <span class="subtle">Checking what you can do with this record…</span>
        ) : (
          blocked.length > 0 && (
            <div class="action-note">
              <Icon name="info" />
              <div>
                {blockedNote.map((b) => (
                  <div key={b}>{b}</div>
                ))}
              </div>
            </div>
          )
        )}
        {access.error && !isCancelled(access.error) ? <span class="subtle">Couldn't check your record access; Salesforce will enforce it when you save.</span> : null}
        <details class="record-technical">
          <summary>Record information</summary>
          <div class="record-technical-grid">
            <div><span>Record ID</span><span class="row nowrap"><code>{id}</code><CopyButton value={id} label="Copy record ID" /></span></div>
            <div><span>Object API name</span><span class="row nowrap"><code>{d.name}</code><CopyButton value={d.name} label="Copy object API name" /></span></div>
            <div class="record-technical-links"><button class="link-button" onClick={() => ws.navigate({ tool: 'objects', params: { objectApiName: d.name } })}>Object details</button><a href={objectManagerUrl(ws.org!, d.name)} target="_blank" rel="noopener noreferrer">Object Manager</a></div>
          </div>
        </details>
        <div class="subnav record-tabs" role="tablist" aria-label="Record sections">
          {tabs.map(([t, label]) => (
            <button key={t} role="tab" id={`rt-${t}`} aria-selected={tab === t} aria-controls="record-panel" onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <div id="record-panel" role="tabpanel" aria-labelledby={`rt-${tab}`} class="stack">
        {tab === 'details' ? (
          <DetailsTab rec={rec} />
        ) : (
          <>
            <LinkedRecords rec={rec} />
            <RelatedTab rec={rec} id={id} />
          </>
        )}
      </div>
      {editing && (
        <RecordForm
          mode="edit"
          describe={d}
          recordId={id}
          values={rec.values}
          lookupNames={Object.fromEntries(rec.lookups.filter((l) => l.name).map((l) => [l.field.name, l.name!]))}
          onClose={() => {
            setEditing(false);
            setPendingDraft(hasStoredDraft(orgKey, 'edit', id));
          }}
          onSaved={({ name }) => {
            ws.notifyRecordChange({ type: 'updated', id, objectApiName: d.name });
            toast({ message: `Saved changes to “${name || title}”.` });
            setPendingDraft(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function Navigator() {
  const ws = useWorkspace();
  const tabRecord = ws.orgMatchesTab ? ws.page.recordId : undefined;
  const tabObject = ws.orgMatchesTab ? ws.page.objectApiName : undefined;
  const paramId = ws.route.params?.recordId;
  const [manualId, setManualId] = useState<string | undefined>(paramId);

  // Following Lightning navigation: opening another record in the tab replaces a picked record.
  const [lastTabRecord, setLastTabRecord] = useState(tabRecord);
  useEffect(() => {
    if (tabRecord !== lastTabRecord) {
      setLastTabRecord(tabRecord);
      if (tabRecord) setManualId(undefined);
    }
  }, [tabRecord]);
  // The picked record follows the route, so Back/forward restore what was on screen.
  useEffect(() => setManualId(paramId), [paramId]);

  const recordId = manualId ?? tabRecord;
  const objectHint = recordId && recordId === tabRecord ? tabObject : undefined;

  const wasDeleted = !!recordId && ws.deletedIds.has(recordId.slice(0, 15));
  const { data, error, loading, run } = useAsync(
    recordId && !wasDeleted && ws.client && ws.metadata ? (signal) => loadRecord(ws.client!, ws.metadata!, recordId, objectHint, signal) : null,
    [recordId, objectHint, ws.client, ws.metadata, wasDeleted],
  );

  return (
    <>
      {manualId && tabRecord && manualId !== tabRecord && (
        <div class="alert info row">
          <span class="grow">You're viewing a record you picked, not the one open in the Salesforce tab.</span>
          <button
            class="btn small"
            onClick={() => {
              setManualId(undefined);
              ws.navigate({ tool: 'record' }, { replace: true });
            }}
          >
            Show the tab's record
          </button>
        </div>
      )}
      {wasDeleted ? (
        <EmptyState title="This record was deleted" icon="trash">
          <p>You deleted it in this session. It's in the Salesforce Recycle Bin if you need to restore it.</p>
          <button class="btn primary" onClick={() => ws.navigate({ tool: 'recordSearch' })}>
            <Icon name="search" /> Find another record
          </button>
        </EmptyState>
      ) : !recordId ? (
        <EmptyState title="No record open" icon="record">
          <p>Open a record in the Salesforce tab and it shows up here automatically, or find one by name or ID.</p>
          <button class="btn primary" onClick={() => ws.navigate({ tool: 'recordSearch' })}>
            <Icon name="search" /> Search records
          </button>
        </EmptyState>
      ) : loading && !data ? (
        <Loading label="Loading record…" />
      ) : error ? (
        <>
          <ErrorAlert error={error} onRetry={run} />
          {explainError(error).kind === 'notFound' && <Alert kind="info">The record may be deleted or not shared with you. Salesforce only returns records your user can see.</Alert>}
        </>
      ) : data ? (
        <RecordView
          key={recordId}
          rec={data}
          onChanged={run}
          onDeleted={() => {
            setManualId(undefined);
            ws.navigate({ tool: 'recordSearch' }, { replace: true });
          }}
        />
      ) : null}
    </>
  );
}

export function RecordNavigator() {
  return (
    <ConnectionGate>
      <Navigator />
    </ConnectionGate>
  );
}
