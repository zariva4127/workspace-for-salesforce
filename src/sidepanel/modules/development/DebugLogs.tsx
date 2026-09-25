/**
 * Debug log viewer. Lists ApexLog records via the Tooling API (read-only) and
 * analyzes a log body: errors, limits, SOQL, DML, debug statements, and a
 * filterable event list. Pasted logs are analyzed without any connection.
 */
import { SearchInput } from '../../components/SearchInput';
import { useMemo, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { ConnectionGate } from '../../components/ConnectionGate';
import { Alert, EmptyState, ErrorAlert, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useAsync } from '../../hooks/useAsync';
import { downloadText } from '../../utils/download';
import { soqlString } from '../../../shared/api/client';
import { DEBUG_EVENT_FILTERS, limitsNearMax, parseDebugLog } from '../../../shared/parsers/debugLog';

interface ApexLogRow {
  Id: string;
  LogUser?: { Name: string } | null;
  Operation: string;
  Request: string;
  Status: string;
  LogLength: number;
  StartTime: string;
  DurationMilliseconds: number;
}

function LogAnalysis({ body, name }: { body: string; name: string }) {
  const s = useMemo(() => parseDebugLog(body), [body]);
  const [category, setCategory] = useState<string>('All');
  const [q, setQ] = useState('');
  const near = limitsNearMax(s.limits);

  const events = useMemo(() => {
    const types = category === 'All' ? null : new Set(DEBUG_EVENT_FILTERS[category]);
    const term = q.trim().toLowerCase();
    return s.events.filter((e) => (!types || types.has(e.type)) && (!term || e.detail.toLowerCase().includes(term) || e.type.toLowerCase().includes(term)));
  }, [s, category, q]);

  return (
    <>
      <section class="card stack" aria-labelledby="log-sum">
        <div class="card-title">
          <h2 id="log-sum">Log summary</h2>
          <button class="btn small" onClick={() => downloadText(`${name}.log`, body)}>
            <Icon name="download" /> Raw log
          </button>
        </div>
        <div class="row">
          <span class="pill">{s.events.length.toLocaleString()} events</span>
          {s.durationMs !== undefined && <span class="pill">{s.durationMs.toLocaleString()} ms</span>}
          <span class={`pill ${s.errors.length ? 'error' : 'ok'}`}>{s.errors.length} error(s)</span>
          <span class="pill">{s.soql.length} SOQL</span>
          <span class="pill">{s.dml.length} DML</span>
          {s.apiVersion && <span class="pill">API {s.apiVersion}</span>}
        </div>
        {s.truncated && <Alert kind="warning" title="Log truncated">Salesforce skipped part of this log because it exceeded the size limit. Lower log levels for less important categories and reproduce.</Alert>}
        {s.logLevels && <div class="subtle break">Levels: {s.logLevels}</div>}
        {s.events.length === 0 && <Alert kind="info">No log events were recognized. Make sure you pasted a complete Apex debug log.</Alert>}
      </section>

      {s.errors.length > 0 && (
        <section class="card stack" aria-labelledby="log-err">
          <h2 id="log-err">Errors</h2>
          <ul class="list">
            {s.errors.map((e) => (
              <li key={e.index}>
                <div class="grow">
                  <div class="row">
                    <span class="pill error">{e.type}</span>
                    <span class="subtle">
                      {e.time}
                      {e.line ? ` · line ${e.line}` : ''}
                    </span>
                  </div>
                  <pre class="log">{e.detail}</pre>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {s.limits.length > 0 && (
        <section class="card stack" aria-labelledby="log-lim">
          <h2 id="log-lim">Governor limits</h2>
          {near.length > 0 && <Alert kind="warning">{near.length} limit(s) at or above 70% of the maximum.</Alert>}
          <ul class="list">
            {s.limits
              .filter((l) => l.used > 0 || near.includes(l))
              .map((l) => {
                const ratio = l.max ? l.used / l.max : 0;
                return (
                  <li key={`${l.namespace}-${l.name}`}>
                    <div class="grow stack" style={{ gap: 2 }}>
                      <div class="row">
                        <span class="grow">{l.name}</span>
                        <span class="subtle">
                          {l.used.toLocaleString()} / {l.max.toLocaleString()} {l.namespace !== 'default' && l.namespace !== '(default)' ? `· ${l.namespace}` : ''}
                        </span>
                      </div>
                      <div class={`meter ${ratio >= 0.9 ? 'high' : ratio >= 0.7 ? 'warn' : ''}`} aria-hidden="true">
                        <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                      </div>
                    </div>
                  </li>
                );
              })}
          </ul>
        </section>
      )}

      {s.soql.length > 0 && (
        <details class="card">
          <summary>SOQL queries ({s.soql.length})</summary>
          <ul class="list">
            {s.soql.map((x, i) => (
              <li key={i}>
                <code class="grow break">{x.query}</code>
                <span class="subtle">{x.rows !== undefined ? `${x.rows} rows` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {s.dml.length > 0 && (
        <details class="card">
          <summary>DML operations ({s.dml.length})</summary>
          <ul class="list">
            {s.dml.map((x, i) => (
              <li key={i}>
                <span class="grow">
                  {x.operation} {x.objectType}
                </span>
                <span class="subtle">
                  {x.rows} row(s){x.line ? ` · line ${x.line}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <section class="card stack" aria-labelledby="log-ev">
        <h2 id="log-ev">Events</h2>
        <div class="subnav pills" role="radiogroup" aria-label="Event category" style={{ padding: 0 }}>
          {['All', ...Object.keys(DEBUG_EVENT_FILTERS)].map((c) => (
            <button key={c} role="radio" aria-checked={category === c} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        <SearchInput placeholder="Search events" label="Search events" value={q} onValue={setQ} />
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Event</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 1000).map((e) => (
                <tr key={e.index}>
                  <td class="mono">{e.time}</td>
                  <td class="mono">
                    {e.type}
                    {e.line ? ` [${e.line}]` : ''}
                  </td>
                  <td class="mono break" style={{ whiteSpace: 'pre-wrap' }}>
                    {e.detail.length > 600 ? `${e.detail.slice(0, 600)}…` : e.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {events.length > 1000 && <p class="subtle">Showing 1,000 of {events.length.toLocaleString()} events. Filter to narrow down.</p>}
      </section>
    </>
  );
}

function OrgLogs() {
  const ws = useWorkspace();
  const [mine, setMine] = useState(true);
  const [selected, setSelected] = useState<ApexLogRow | null>(null);
  const list = useAsync(
    ws.client
      ? (signal) =>
          ws.client!.query<ApexLogRow>(
            `SELECT Id, LogUser.Name, Operation, Request, Status, LogLength, StartTime, DurationMilliseconds FROM ApexLog${
              mine && ws.session ? ` WHERE LogUserId = ${soqlString(ws.session.userId)}` : ''
            } ORDER BY StartTime DESC LIMIT 50`,
            { tooling: true, signal },
          )
      : null,
    [ws.client, mine],
  );
  const body = useAsync(selected && ws.client ? (signal) => ws.client!.apexLogBody(selected.Id, signal) : null, [selected?.Id, ws.client]);

  if (selected) {
    return (
      <>
        <button class="btn small ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setSelected(null)}>
          ← All logs
        </button>
        <div class="subtle">
          {selected.Operation} · {new Date(selected.StartTime).toLocaleString()} · {selected.LogUser?.Name}
        </div>
        {body.loading ? <Loading label="Downloading log…" /> : body.error ? <ErrorAlert error={body.error} onRetry={body.run} /> : body.data !== undefined ? <LogAnalysis body={body.data} name={selected.Id} /> : null}
      </>
    );
  }

  return (
    <section class="card stack">
      <div class="card-title">
        <h2>Recent debug logs</h2>
        <button class="btn small" onClick={list.run} disabled={list.loading}>
          <Icon name="refresh" /> Refresh
        </button>
      </div>
      <label class="check">
        <input type="checkbox" checked={mine} onChange={(e) => setMine(e.currentTarget.checked)} /> Only my logs
      </label>
      <p class="subtle">Logs appear here when a trace flag is already active. This read-only release does not create trace flags because that changes org configuration.</p>
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <ErrorAlert error={list.error} onRetry={list.run} />
      ) : list.data && list.data.records.length === 0 ? (
        <EmptyState title="No logs found">
          <p>Add a trace flag for your user, reproduce the issue, then refresh.</p>
        </EmptyState>
      ) : (
        <ul class="list">
          {list.data?.records.map((l) => (
            <li key={l.Id}>
              <div class="grow">
                <div class="break">
                  <strong>{l.Operation}</strong> <span class={`pill ${l.Status === 'Success' ? 'ok' : 'error'}`}>{l.Status}</span>
                </div>
                <div class="subtle">
                  {new Date(l.StartTime).toLocaleString()} · {l.LogUser?.Name} · {(l.LogLength / 1024).toFixed(0)} KB · {l.DurationMilliseconds} ms
                </div>
              </div>
              <button class="btn small" onClick={() => setSelected(l)}>
                Analyze
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DebugLogs() {
  const [mode, setMode] = useState<'org' | 'paste'>('org');
  const [pasted, setPasted] = useState('');
  return (
    <>
      <div class="subnav pills" role="tablist" aria-label="Log source" style={{ padding: 0 }}>
        <button role="tab" aria-selected={mode === 'org'} onClick={() => setMode('org')}>
          From org
        </button>
        <button role="tab" aria-selected={mode === 'paste'} onClick={() => setMode('paste')}>
          Paste a log
        </button>
      </div>
      {mode === 'org' ? (
        <ConnectionGate>
          <OrgLogs />
        </ConnectionGate>
      ) : (
        <>
          <section class="card stack">
            <div class="field">
              <label for="log-in">Apex debug log</label>
              <textarea id="log-in" class="code" rows={8} spellcheck={false} value={pasted} onInput={(e) => setPasted(e.currentTarget.value)} />
              <span class="hint">Analyzed locally in this panel.</span>
            </div>
          </section>
          {pasted.trim() ? <LogAnalysis body={pasted} name="pasted" /> : <EmptyState title="Paste a debug log to analyze it" />}
        </>
      )}
    </>
  );
}
