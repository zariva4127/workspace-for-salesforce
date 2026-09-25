/**
 * Connection experience. Every API-backed tool renders only when the org is
 * connected; otherwise one screen explains the situation in plain language:
 * no Salesforce tab, a login page, connecting, session expired, API access
 * denied, or a connection failure. It shows a live status checklist, lets the
 * user pick another open Salesforce tab or open a known org, and retries.
 * Session credentials are never shown or requested.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useWorkspace } from '../state/workspace';
import { OrgBadge } from './OrgBadge';
import { Alert, Loading } from './States';
import { Icon } from './Icon';
import { clientIdFor, redirectUri } from '../services/auth';
import { CopyButton } from './CopyButton';
import { displayName, effectiveEnvironment } from '../../shared/org/profiles';
import { detectPageContext, PAGE_TYPE_LABELS } from '../../shared/context/pageContext';

export type ConnState = 'checking' | 'no-tab' | 'login' | 'other-org' | 'ready' | 'connecting' | 'expired' | 'denied' | 'failed' | 'connected';

export function useConnState(): ConnState {
  const ws = useWorkspace();
  if (ws.tab.loading) return 'checking';
  // The tab's org is known but its saved profile is still loading: don't flash "no org".
  if (!ws.org && ws.page.org && !ws.pinnedOrgKey) return 'checking';
  if (!ws.org) return ws.page.pageType === 'login' ? 'login' : 'no-tab';
  if (ws.status === 'connected' && ws.client) return 'connected';
  if (ws.status === 'unknown') return 'checking';
  if (ws.status === 'connecting') return 'connecting';
  if (ws.connectionError) return ws.connectionErrorKind === 'denied' ? 'denied' : 'failed';
  if (ws.status === 'expired') return 'expired';
  if (!ws.orgMatchesTab) return 'other-org';
  return 'ready';
}

/** Salesforce tabs open in this browser (URLs are visible only for Salesforce hosts). */
function useSalesforceTabs(): chrome.tabs.Tab[] {
  const [tabs, setTabs] = useState<chrome.tabs.Tab[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      chrome.tabs.query({}).then(
        (all) => alive && setTabs(all.filter((t) => detectPageContext(t.url).org).slice(0, 8)),
        () => undefined,
      );
    void load();
    const onChange = () => void load();
    chrome.tabs.onUpdated.addListener(onChange);
    chrome.tabs.onRemoved?.addListener(onChange);
    chrome.tabs.onCreated?.addListener(onChange);
    return () => {
      alive = false;
      chrome.tabs.onUpdated.removeListener(onChange);
      chrome.tabs.onRemoved?.removeListener(onChange);
      chrome.tabs.onCreated?.removeListener(onChange);
    };
  }, []);
  return tabs;
}

const COPY: Record<Exclude<ConnState, 'connected'>, { title: string; body: string; tone: 'info' | 'warning' | 'error' | 'progress' }> = {
  checking: { title: 'Checking your Salesforce tab…', body: 'This only takes a moment.', tone: 'progress' },
  'no-tab': {
    title: 'Connect to a Salesforce org',
    body: 'The workspace works with the Salesforce tab you open it from. Switch to a Salesforce tab below, or open an org you’ve used before.',
    tone: 'info',
  },
  login: { title: 'Sign in to Salesforce', body: 'This tab shows a Salesforce login page. Sign in there and the workspace connects automatically.', tone: 'info' },
  'other-org': {
    title: 'This org isn’t open in your Salesforce tab',
    body: 'Tools use the org you picked, but its session comes from a Salesforce tab. Switch to a tab for this org, or go back to following the current tab.',
    tone: 'info',
  },
  ready: { title: 'Ready to connect', body: 'The workspace uses the Salesforce session you’re already signed in with. No password or extra login needed.', tone: 'info' },
  connecting: { title: 'Connecting to Salesforce…', body: 'Checking your session with Salesforce.', tone: 'progress' },
  expired: {
    title: 'Your Salesforce session ended',
    body: 'Salesforce signed you out, or the tab moved to another page. Refresh the Salesforce tab (sign in if asked), then reconnect.',
    tone: 'warning',
  },
  denied: {
    title: 'Your user can’t use the Salesforce API',
    body: 'Salesforce accepted your sign-in but refused API access. This usually means the “API Enabled” permission is missing from your profile or permission sets, or your org’s edition doesn’t include API access. Ask your Salesforce admin.',
    tone: 'error',
  },
  failed: { title: 'Couldn’t connect', body: 'Something went wrong while connecting. Check the details below, then try again.', tone: 'error' },
};

function StatusChecklist({ state }: { state: ConnState }) {
  const ws = useWorkspace();
  const onSf = ws.page.isSalesforce && !!ws.page.org;
  const steps: Array<{ label: string; detail: string; st: 'ok' | 'fail' | 'wait' | 'todo' }> = [
    {
      label: 'Salesforce tab',
      detail: onSf ? `${PAGE_TYPE_LABELS[ws.page.pageType]} on ${ws.page.org!.myDomain}` : ws.page.pageType === 'login' ? 'Login page — sign in first' : 'Not a Salesforce page',
      st: onSf ? 'ok' : state === 'checking' ? 'wait' : 'fail',
    },
    { label: 'Org', detail: ws.org ? displayName(ws.org) : 'Not identified yet', st: ws.org ? 'ok' : 'todo' },
    {
      label: 'Signed-in session',
      detail:
        state === 'connected' ? `Connected${ws.org?.username ? ` as ${ws.org.username}` : ''}` : state === 'connecting' || state === 'checking' ? 'Checking…' : state === 'expired' ? 'Expired' : state === 'denied' ? 'API access refused' : state === 'failed' ? 'Failed' : 'Not connected',
      st: state === 'connected' ? 'ok' : state === 'connecting' || state === 'checking' ? 'wait' : ['expired', 'denied', 'failed'].includes(state) ? 'fail' : 'todo',
    },
  ];
  return (
    <ol class="checklist" aria-label="Connection status">
      {steps.map((s) => (
        <li key={s.label} class={`check-${s.st}`}>
          <span class="check-mark" aria-hidden="true">
            {s.st === 'ok' ? <Icon name="check" /> : s.st === 'fail' ? <Icon name="close" /> : s.st === 'wait' ? <span class="spinner small" /> : null}
          </span>
          <span class="grow">
            <strong>{s.label}</strong>
            <span class="subtle">{s.detail}</span>
          </span>
          <span class="visually-hidden">{s.st === 'ok' ? 'done' : s.st === 'fail' ? 'problem' : s.st === 'wait' ? 'in progress' : 'not started'}</span>
        </li>
      ))}
    </ol>
  );
}

function OAuthFallback() {
  const ws = useWorkspace();
  const org = ws.org!;
  const hasClientId = !!clientIdFor(org, ws.settings);
  const [clientId, setClientId] = useState(ws.settings.clientId);
  return (
    <details class="subtle-details">
      <summary>Other ways to connect</summary>
      <div class="stack">
        <p class="muted">Use OAuth only if your org doesn't allow its browser session to call APIs. It needs a one-time External Client App in Salesforce.</p>
        {hasClientId ? (
          <div class="row">
            <button class="btn" onClick={() => void ws.connect()} disabled={ws.status === 'connecting'}>
              Sign in with OAuth
            </button>
            <button class="btn ghost" onClick={() => void ws.connect({ switchUser: true })} disabled={ws.status === 'connecting'}>
              As a different user
            </button>
          </div>
        ) : (
          <>
            <div class="field">
              <label for="inline-callback">Callback URL for the app</label>
              <div class="row nowrap">
                <input id="inline-callback" class="mono grow" readOnly value={redirectUri()} />
                <CopyButton value={redirectUri()} label="Copy callback URL" />
              </div>
            </div>
            <div class="field">
              <label for="inline-client">Consumer Key</label>
              <div class="row nowrap">
                <input id="inline-client" class="mono grow" value={clientId} autoComplete="off" onInput={(e) => setClientId(e.currentTarget.value)} placeholder="Paste the app's Consumer Key" />
                <button class="btn" disabled={!clientId.trim()} onClick={() => void ws.saveSettings({ clientId: clientId.trim() }).then(() => ws.connect())}>
                  Save & sign in
                </button>
              </div>
              <span class="hint">Full setup steps are in Settings → Connection.</span>
            </div>
          </>
        )}
      </div>
    </details>
  );
}

const FEATURES: Array<[string, string]> = [
  ['Find & edit records', 'Search, view, create, edit, and delete records with your permissions.'],
  ['Explain access', 'See why a user can or can’t reach an object, field, or record.'],
  ['Users & permissions', 'Browse users and their profiles, permission sets, and groups.'],
  ['Develop & debug', 'Run SOQL, read debug logs, and explore objects and fields.'],
];

export function ConnectionScreen() {
  const ws = useWorkspace();
  const state = useConnState();
  const tabs = useSalesforceTabs();
  const [opening, setOpening] = useState(false);
  if (state === 'connected') return null;
  const c = COPY[state];
  const org = ws.org;
  const canUseTab = !!org && ws.orgMatchesTab && ws.tab.tabId !== undefined;
  const otherTabs = tabs.filter((t) => t.id !== ws.tab.tabId);
  const orgTabs = org ? otherTabs.filter((t) => detectPageContext(t.url).org?.key === org.key) : [];

  const openOrg = async (lightningHost: string) => {
    setOpening(true);
    try {
      const t = await chrome.tabs.create({ url: `https://${lightningHost}/lightning/page/home`, active: !ws.pinnedToTab });
      await ws.useSalesforceTab(t);
    } finally {
      setOpening(false);
    }
  };

  return (
    <section class={`conn-screen tone-${c.tone}`} aria-labelledby="conn-title" aria-live="polite">
      <div class="conn-hero">
        <div class="conn-art" aria-hidden="true">
          <span class="conn-ring" />
          <span class="conn-core">{c.tone === 'progress' ? <span class="spinner" /> : <Icon name={c.tone === 'error' ? 'warning' : state === 'expired' ? 'refresh' : 'plug'} />}</span>
        </div>
        <div class="stack" style={{ gap: 4 }}>
          <h2 id="conn-title">{c.title}</h2>
          <p class="muted" style={{ margin: 0 }}>
            {c.body}
          </p>
          {org && <OrgBadge org={org} />}
        </div>
      </div>

      <div class="conn-grid">
        <div class="stack">
          <StatusChecklist state={state} />
          {ws.connectionError && state !== 'denied' && (
            <Alert kind="error" title="What Salesforce said">
              {ws.connectionError}
              {ws.connectionErrorKind === 'network' && <div>Check your internet connection or VPN.</div>}
            </Alert>
          )}
          {org && effectiveEnvironment(org) === 'production' && state !== 'no-tab' && <Alert kind="warning">This is a production org. Changes made here affect real users and data.</Alert>}
          <div class="row">
            {(state === 'ready' || state === 'expired' || state === 'failed' || state === 'denied') && (
              <button class="btn primary" onClick={() => void ws.connect({ browserSession: true })} disabled={!canUseTab}>
                <Icon name="plug" /> {state === 'ready' ? 'Connect' : state === 'expired' ? 'Reconnect' : 'Try again'}
              </button>
            )}
            {state === 'other-org' && (
              <button class="btn primary" onClick={() => ws.pinOrg(null)}>
                Follow the Salesforce tab
              </button>
            )}
            {state !== 'checking' && state !== 'connecting' && (
              <button class="btn" onClick={ws.retry}>
                <Icon name="refresh" /> Check again
              </button>
            )}
          </div>
          {org && (state === 'ready' || state === 'expired' || state === 'failed') && <OAuthFallback />}
        </div>

        {state !== 'checking' && state !== 'connecting' && (
          <div class="stack">
            {(state === 'no-tab' || state === 'login' || state === 'other-org' || otherTabs.length > 0) && (
              <div class="conn-panel">
                <h3>Open Salesforce tabs</h3>
                {(orgTabs.length ? orgTabs : otherTabs).length === 0 ? (
                  <p class="subtle">No other Salesforce tabs are open.</p>
                ) : (
                  <ul class="result-list">
                    {(orgTabs.length ? orgTabs : otherTabs).map((t) => {
                      const ctx = detectPageContext(t.url);
                      const known = ws.orgs.find((o) => o.key === ctx.org?.key);
                      return (
                        <li key={t.id}>
                          <span class="result-main" style={{ cursor: 'default' }}>
                            <strong>{t.title || ctx.org?.myDomain}</strong>
                            <span>
                              {known ? displayName(known) : ctx.org?.myDomain} · {PAGE_TYPE_LABELS[ctx.pageType]}
                            </span>
                          </span>
                          <button class="btn small" onClick={() => void ws.useSalesforceTab(t)}>
                            Use this tab
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            {!org && ws.orgs.length > 0 && (
              <div class="conn-panel">
                <h3>Orgs you’ve used</h3>
                <ul class="list compact">
                  {ws.orgs.slice(0, 6).map((o) => (
                    <li key={o.key}>
                      <span class="grow">
                        <OrgBadge org={o} />
                      </span>
                      <button class="btn small" disabled={opening} onClick={() => void openOrg(o.lightningHost)}>
                        <Icon name="external" /> Open
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!org && (
              <div class="row">
                <button class="btn small" onClick={() => void chrome.tabs.create({ url: 'https://login.salesforce.com/' })}>
                  <Icon name="external" /> Sign in to Salesforce
                </button>
                <button class="btn small ghost" onClick={() => void chrome.tabs.create({ url: 'https://test.salesforce.com/' })}>
                  Sandbox login
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {(state === 'no-tab' || state === 'login') && (
        <div class="conn-features">
          <h3>What you can do once connected</h3>
          <ul>
            {FEATURES.map(([t, d]) => (
              <li key={t}>
                <strong>{t}</strong>
                <span class="subtle">{d}</span>
              </li>
            ))}
          </ul>
          <p class="subtle" style={{ margin: 0 }}>
            Flow error help, deployment error help, debug log analysis, and the form tester work on pasted text without connecting.{' '}
            <button class="link-button" onClick={() => ws.navigate({ tool: 'flowErrors' })}>
              Try the flow error translator
            </button>
          </p>
        </div>
      )}
    </section>
  );
}

/** Shown where a tool needs an org but none is selected. */
export function NoOrgState() {
  return <ConnectionScreen />;
}

export function ConnectionGate({ children }: { children: ComponentChildren }) {
  const state = useConnState();
  if (state === 'checking') return <Loading label="Checking your Salesforce tab…" />;
  if (state !== 'connected') return <ConnectionScreen />;
  return <>{children}</>;
}
