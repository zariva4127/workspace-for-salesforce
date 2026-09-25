/**
 * Access explainer: shows what the Salesforce APIs can confirm about a user's
 * access to an object, a field, and optionally a record — with explicit
 * confidence labels. Field access is never presented as record access.
 */
import { useEffect, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { SearchInput } from '../../components/SearchInput';
import { Icon } from '../../components/Icon';
import { ConnectionGate } from '../../components/ConnectionGate';
import { Alert, ErrorAlert, Loading } from '../../components/States';
import { FieldPicker, ObjectPicker, useDescribe, useObjects } from '../../components/Pickers';
import { soqlString } from '../../../shared/api/client';
import { collectAccessInput, searchUsers, type UserOption } from '../../../shared/access/queries';
import { interpretAccess, type AccessInput, type AccessResult, type Verdict } from '../../../shared/access/interpret';
import { isSalesforceId, to18 } from '../../../shared/salesforce/ids';
import { isCancelled } from '../../../shared/api/errors';

const STATUS_LABEL: Record<Verdict['status'], string> = {
  granted: 'Yes',
  denied: 'No',
  unknown: 'Unknown',
  notEvaluated: 'Not checked',
  notApplicable: 'N/A',
};
const CONF_LABEL: Record<Verdict['confidence'], string> = { confirmed: 'Confirmed', likely: 'Likely', uncertain: 'Uncertain' };

function VerdictRow({ label, v }: { label: string; v: Verdict }) {
  return (
    <li>
      <div style={{ minWidth: 86 }}>
        <strong>{label}</strong>
      </div>
      <div class="grow stack" style={{ gap: 2 }}>
        <div class="row">
          <span class={`pill ${v.status}`}>{STATUS_LABEL[v.status]}</span>
          <span class="subtle">{CONF_LABEL[v.confidence]}</span>
        </div>
        <div class="muted">{v.reason}</div>
        {v.grantedBy.length > 0 && <div class="subtle">Granted by: {v.grantedBy.join('; ')}</div>}
      </div>
    </li>
  );
}

function UserPicker({ user, onChange }: { user: UserOption | null; onChange: (u: UserOption | null) => void }) {
  const ws = useWorkspace();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<UserOption[] | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const search = async (e?: Event) => {
    e?.preventDefault();
    if (!ws.client || term.trim().length < 2) return;
    setBusy(true);
    setError(undefined);
    try {
      setResults(await searchUsers(ws.client, term.trim()));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const me = async () => {
    if (!ws.client || !ws.session) return;
    setBusy(true);
    try {
      const r = await ws.client.query<UserOption>(`SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE Id = ${soqlString(ws.session.userId)}`);
      if (r.records[0]) onChange(r.records[0]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const clearUser = () => {
    setResults(null);
    onChange(null);
    setTimeout(() => document.getElementById('acc-user')?.focus());
  };

  return (
    <div class="stack">
      {user ? (
        <div class="field">
          <label for="acc-user-selected">User</label>
          <div class="row nowrap">
            <div class="combobox-control grow">
              <input id="acc-user-selected" readOnly class="lookup-selected" value={`${user.Name} (${user.Username})`} onKeyDown={(e) => (e.key === 'Backspace' || e.key === 'Delete') && clearUser()} />
              <button type="button" class="combobox-clear" aria-label="Clear user" title="Clear" onClick={clearUser}>
                <Icon name="close" />
              </button>
            </div>
            <button class="btn small" onClick={() => ws.navigate({ tool: 'record', params: { recordId: user.Id } })}>
              Inspect user
            </button>
          </div>
        </div>
      ) : (
        <form class="field" onSubmit={search}>
          <label for="acc-user">User</label>
          <div class="row">
            <SearchInput id="acc-user" class="grow" label="Search users" placeholder="Search by name or username" value={term} onValue={setTerm} />
            <div class="row nowrap">
              <button class="btn" type="submit" disabled={busy || term.trim().length < 2}>
                Search
              </button>
              <button class="btn" type="button" onClick={me} disabled={busy} title="Check your own access">
                Use me
              </button>
            </div>
          </div>
        </form>
      )}
      {error ? <ErrorAlert error={error} /> : null}
      {results && !user && (
        <ul class="result-list" aria-label="Matching users">
          {results.length === 0 && <li class="muted">No users found.</li>}
          {results.map((u) => (
            <li key={u.Id}>
              <button class="result-main" onClick={() => onChange(u)}>
                <strong>
                  {u.Name} {!u.IsActive && <span class="pill">Inactive</span>}
                </strong>
                <span>
                  {u.Username} · {u.Profile?.Name ?? 'No profile visible'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Results({ result, input }: { result: AccessResult; input: AccessInput }) {
  return (
    <>
      <section class="card stack" aria-labelledby="acc-sum">
        <h2 id="acc-sum">Summary</h2>
        <p>{result.summary}</p>
        {result.notes.map((n) => (
          <Alert key={n} kind="info">
            {n}
          </Alert>
        ))}
      </section>
      <section class="card" aria-labelledby="acc-obj">
        <h2 id="acc-obj">Object permissions — {input.objectApiName}</h2>
        <ul class="list">
          <VerdictRow label="Read" v={result.object.read} />
          <VerdictRow label="Create" v={result.object.create} />
          <VerdictRow label="Edit" v={result.object.edit} />
          <VerdictRow label="Delete" v={result.object.delete} />
          <VerdictRow label="View All" v={result.object.viewAll} />
          <VerdictRow label="Modify All" v={result.object.modifyAll} />
        </ul>
      </section>
      {result.field && input.field && (
        <section class="card" aria-labelledby="acc-fld">
          <h2 id="acc-fld">Field-level security — {input.field.apiName}</h2>
          <ul class="list">
            <VerdictRow label="Read" v={result.field.read} />
            <VerdictRow label="Edit" v={result.field.edit} />
          </ul>
        </section>
      )}
      <section class="card" aria-labelledby="acc-rec">
        <h2 id="acc-rec">Record access{input.record ? ` — ${input.record.id}` : ''}</h2>
        <ul class="list">
          <VerdictRow label="Read" v={result.record.read} />
          <VerdictRow label="Edit" v={result.record.edit} />
          <VerdictRow label="Delete" v={result.record.delete} />
        </ul>
      </section>
      {input.sources.ok && (
        <section class="card" aria-labelledby="acc-src">
          <h2 id="acc-src">Assignments considered ({input.sources.value.length})</h2>
          <ul class="plain">
            {input.sources.value.map((s) => (
              <li key={s.id}>
                {s.label}
                {s.requiresActivation ? ' (session activation required)' : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
      <details class="card">
        <summary>What this can't tell you</summary>
        <ul class="plain">
          <li>Record access is only confirmed through UserRecordAccess for a specific record. Org-wide defaults, role hierarchy, sharing rules, teams, and territories are not evaluated individually.</li>
          <li>Restriction rules, scoping rules, and Apex-managed or implicit sharing are reflected only in the UserRecordAccess result.</li>
          <li>Permission set group muting is applied by Salesforce in the group's aggregate permissions; results use those aggregates.</li>
          <li>Results depend on what your own user may query. Missing "View Setup and Configuration" or "View All Users" can hide data and produce "Unknown".</li>
          <li>Page layouts, Lightning record page visibility, and field dependencies can still hide a field the user is allowed to see.</li>
        </ul>
      </details>
    </>
  );
}

function Explainer() {
  const ws = useWorkspace();
  const objects = useObjects();
  const tabObject = ws.orgMatchesTab ? ws.page.objectApiName : undefined;
  const [user, setUser] = useState<UserOption | null>(null);
  // Opened from a user's page: preselect that user.
  const presetUserId = ws.route.params?.userId;
  useEffect(() => {
    if (!presetUserId || !ws.client) return;
    const ctrl = new AbortController();
    ws.client
      .query<UserOption>(`SELECT Id, Name, Username, IsActive, Profile.Name FROM User WHERE Id = ${soqlString(presetUserId)}`, { signal: ctrl.signal })
      .then((r) => r.records[0] && setUser(r.records[0]), () => undefined);
    return () => ctrl.abort();
  }, [presetUserId, ws.client]);
  const [objectApiName, setObjectApiName] = useState(tabObject ?? '');
  const [fieldName, setFieldName] = useState('');
  const [recordId, setRecordId] = useState(ws.orgMatchesTab && ws.page.recordId ? ws.page.recordId : '');
  const describe = useDescribe(objectApiName || undefined);
  const [state, setState] = useState<{ loading: boolean; error?: unknown; result?: AccessResult; input?: AccessInput }>({ loading: false });
  const [ctrl, setCtrl] = useState<AbortController | null>(null);

  useEffect(() => setFieldName(''), [objectApiName]);
  // Results always describe the current selection; clear them when any input changes.
  useEffect(() => {
    ctrl?.abort();
    setState({ loading: false });
  }, [user?.Id, objectApiName, fieldName, recordId]);
  useEffect(() => () => ctrl?.abort(), [ctrl]);

  const recordValid = !recordId.trim() || isSalesforceId(recordId.trim());
  const canRun = !!user && !!objectApiName && !!describe.data && recordValid;
  const missing = !user ? 'Choose a user first.' : !objectApiName ? 'Choose an object.' : !recordValid ? 'The record ID isn’t valid (15 or 18 characters).' : describe.loading ? 'Loading the object…' : undefined;

  const run = async () => {
    if (!ws.client || !user || !describe.data) return;
    ctrl?.abort();
    const c = new AbortController();
    setCtrl(c);
    setState({ loading: true });
    const f = describe.data.value.fields.find((x) => x.name === fieldName);
    try {
      const input = await collectAccessInput(
        ws.client,
        {
          user,
          objectApiName: describe.data.value.name,
          ...(f ? { field: { apiName: f.name, permissionable: f.permissionable, calculated: f.calculated, updateable: f.updateable } } : {}),
          ...(recordId.trim() ? { recordId: to18(recordId.trim()) } : {}),
        },
        c.signal,
      );
      setState({ loading: false, input, result: interpretAccess(input) });
    } catch (e) {
      setState(isCancelled(e) ? { loading: false } : { loading: false, error: e });
    }
  };

  return (
    <>
      <section class="card stack narrow">
        <UserPicker user={user} onChange={setUser} />
        <ObjectPicker id="acc-obj-in" label="Object" value={objectApiName} onChange={setObjectApiName} objects={objects.data?.value} />
        <FieldPicker id="acc-field" label="Field (optional)" fields={describe.data?.value.fields} value={fieldName} onChange={setFieldName} optional />
        {describe.data && <span class="hint">Only fields visible to your own user are listed.</span>}
        <div class="field">
          <label for="acc-rec-in">Record ID (optional)</label>
          <input id="acc-rec-in" class="mono" value={recordId} aria-invalid={!recordValid} onInput={(e) => setRecordId(e.currentTarget.value)} placeholder="Check record-level access for one record" />
        </div>
        {describe.error ? <ErrorAlert error={describe.error} /> : null}
        <div class="row">
          <button class="btn primary" onClick={run} disabled={!canRun || state.loading}>
            Explain access
          </button>
          {!state.loading && missing && <span class="hint">{missing}</span>}
          {state.loading && (
            <button class="btn" onClick={() => ctrl?.abort()}>
              Cancel
            </button>
          )}
        </div>
      </section>
      {state.loading && <Loading label="Reading assignments and permissions…" />}
      {state.error ? <ErrorAlert error={state.error} onRetry={run} /> : null}
      {state.result && state.input && <Results result={state.result} input={state.input} />}
    </>
  );
}

export function AccessExplainer() {
  return (
    <ConnectionGate>
      <Explainer />
    </ConnectionGate>
  );
}
