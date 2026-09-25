/**
 * Central state for the side panel: active tab context, selected org, connection,
 * API client, settings, and navigation. Every tool reads from this context so
 * that the org a tool runs against is always explicit and visible.
 */
import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PageContext } from '../../shared/context/pageContext';
import { DEFAULT_SETTINGS, badgeColor, type GlobalSettings, type OrgProfile } from '../../shared/org/profiles';
import { ACCENT_PRESETS, accentTokens, resolveScheme, type AccentTokens, type Scheme } from '../../shared/theme/accent';
import { BOOT_THEME_KEY, accentVars, bootTheme } from '../../shared/theme/bootTheme';
import { parseOrgUrl, resolveEnvironment } from '../../shared/org/identity';
import { SalesforceClient, type ApiUsage } from '../../shared/api/client';
import { MetadataCache } from '../../shared/cache/metadataCache';
import { MetadataService } from '../../shared/salesforce/metadata';
import { explainError } from '../../shared/api/errors';
import { soqlString } from '../../shared/api/client';
import { orgBigStore, profiles, tokenStore } from '../services/platform';
import { addActivity } from '../../shared/workspace/activity';
import { connectOrg, disconnectOrg, refreshOrg } from '../services/auth';
import { connectFromSalesforceTab } from '../services/tabSessionAuth';
import { sourceTabFromUrl, usePageContext, type ActiveTab, type SourceTab } from './usePageContext';
import { TOOLS, type Route, type ToolId } from './routes';

export interface RecordChange {
  type: 'created' | 'updated' | 'deleted';
  id: string;
  objectApiName: string;
}

export type ConnectionStatus = 'unknown' | 'disconnected' | 'connecting' | 'connected' | 'expired';

export interface SessionInfo {
  orgId: string;
  userId: string;
  instanceUrl: string;
}

export interface Workspace {
  tab: ActiveTab;
  page: PageContext;
  /** The org tools run against: the pinned org, or the org of the active tab. */
  org: OrgProfile | null;
  orgs: OrgProfile[];
  pinnedOrgKey: string | null;
  /** True when the selected org is the one in the active tab. */
  orgMatchesTab: boolean;
  settings: GlobalSettings;
  status: ConnectionStatus;
  connectionError?: string;
  session: SessionInfo | null;
  client: SalesforceClient | null;
  metadata: MetadataService | null;
  apiUsage?: ApiUsage;
  route: Route;
  /** The applied theme, for previews and explanations in Settings. */
  theme: { scheme: Scheme; accentHex: string; tokens: AccentTokens };
  recentTools: ToolId[];
  /** Navigates to a tool. Pass `{ replace: true }` to change params without adding a Back step. */
  navigate: (route: Route, opts?: { replace?: boolean }) => void;
  /** Increments after any record is created, edited, or deleted, so lists can refresh. */
  dataVersion: number;
  notifyRecordChange: (change: RecordChange) => void;
  /** IDs deleted in this session, so views can say "deleted" instead of a generic error. */
  deletedIds: ReadonlySet<string>;
  /** Returns to the previous screen, when there is one. */
  back: () => void;
  canGoBack: boolean;
  pinOrg: (key: string | null) => void;
  connect: (opts?: { switchUser?: boolean; browserSession?: boolean }) => Promise<void>;
  /** Why the last connection attempt failed, for choosing the right help text. */
  connectionErrorKind?: 'denied' | 'network' | 'failed';
  /** Points the workspace at another browser tab (and tries to connect). */
  useSalesforceTab: (tab: chrome.tabs.Tab) => Promise<void>;
  /** Re-checks the Salesforce tab and retries the connection. */
  retry: () => void;
  /** True when the workspace runs in its own window pinned to a source tab (vs. the side panel). */
  pinnedToTab: boolean;
  disconnect: () => Promise<void>;
  saveSettings: (patch: Partial<GlobalSettings>) => Promise<void>;
  updateOrg: (key: string, patch: Partial<OrgProfile>) => Promise<void>;
  reloadOrgs: () => Promise<void>;
}

const Ctx = createContext<Workspace | null>(null);

export function useWorkspace(): Workspace {
  const ws = useContext(Ctx);
  if (!ws) throw new Error('useWorkspace outside provider');
  return ws;
}

const ROUTE_KEY = 'ui:lastRoute';
const RECENT_TOOLS_KEY = 'ui:recentTools';

export function WorkspaceProvider({ children }: { children: ComponentChildren }) {
  const [source, setSource] = useState<SourceTab>(sourceTabFromUrl);
  const [retryKey, setRetryKey] = useState(0);
  const tab = usePageContext(source, retryKey);
  const page = tab.ctx;
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  const [orgs, setOrgs] = useState<OrgProfile[]>([]);
  const [pinnedOrgKey, setPinnedOrgKey] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('unknown');
  const [connectionError, setConnectionError] = useState<string>();
  const [connectionErrorKind, setConnectionErrorKind] = useState<Workspace['connectionErrorKind']>();
  const [apiUsage, setApiUsage] = useState<ApiUsage>();
  const [route, setRoute] = useState<Route>({ tool: 'overview' });
  const [recentTools, setRecentTools] = useState<ToolId[]>([]);
  const [history, setHistory] = useState<Route[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(new Set());
  const notifyRecordChange = useCallback((c: RecordChange) => {
    if (c.type === 'deleted') setDeletedIds((s) => new Set([...s, c.id.slice(0, 15)]));
    setDataVersion((v) => v + 1);
    const key = pinnedOrgKey ?? page.org?.key;
    if (key) void addActivity(profiles.scoped(key), { action: `${c.type[0]!.toUpperCase()}${c.type.slice(1)} ${c.objectApiName} record`, status: 'success', detail: c.id });
  }, [pinnedOrgKey, page.org?.key]);
  const lastTokenRef = useRef<string | undefined>(undefined);
  const autoAttemptedRef = useRef(new Set<string>());

  const reloadOrgs = useCallback(async () => setOrgs(await profiles.listOrgs()), []);

  // Settings, org list, and last route; stay in sync with other side panels.
  useEffect(() => {
    void profiles.getSettings().then(setSettings);
    void reloadOrgs();
    try {
      const saved = localStorage.getItem(ROUTE_KEY);
      const parsed = saved ? (JSON.parse(saved) as Route) : undefined;
      // Restore where the user left off, ignoring tools that no longer exist.
      if (parsed && TOOLS.some((t) => t.id === parsed.tool)) setRoute(parsed);
      const recent = localStorage.getItem(RECENT_TOOLS_KEY);
      if (recent) setRecentTools((JSON.parse(recent) as ToolId[]).slice(0, 5));
    } catch {
      // Ignore unavailable storage.
    }
    const onChanged = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local') {
        void profiles.getSettings().then(setSettings);
        void reloadOrgs();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [reloadOrgs]);

  // Register orgs seen in tabs.
  useEffect(() => {
    if (page.org) void profiles.touch(page.org).then(reloadOrgs);
  }, [page.org?.key, reloadOrgs]);

  // Follow the OS light/dark preference live when the theme is "System".
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setPrefersDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  const activeKey = pinnedOrgKey ?? page.org?.key ?? null;
  const org = useMemo(() => orgs.find((o) => o.key === activeKey) ?? null, [orgs, activeKey]);
  const orgMatchesTab = !!org && org.key === page.org?.key;

  // Theme: resolve the scheme, derive accessible accent tokens, and apply them to the whole page.
  const accentHex = settings.accent === 'org' ? (org ? badgeColor(org) : ACCENT_PRESETS.blue.hex) : ACCENT_PRESETS[settings.accent].hex;
  const scheme = resolveScheme(settings.theme, prefersDark);
  const accent = useMemo(() => accentTokens(accentHex, scheme), [accentHex, scheme]);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', scheme);
    const vars = accentVars(accent);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }, [scheme, accent]);

  // Remember the theme so the next open applies it before first paint (theme-boot.js).
  useEffect(() => {
    try {
      localStorage.setItem(BOOT_THEME_KEY, JSON.stringify(bootTheme(settings.theme, accentHex)));
    } catch {
      // Storage unavailable; the theme still applies once settings load.
    }
  }, [settings.theme, accentHex]);

  // Load the session for the selected org.
  const loadSession = useCallback(async (key: string | null) => {
    if (!key) {
      setSession(null);
      setStatus('disconnected');
      return;
    }
    const tokens = (await tokenStore.get(key)) ?? (await tokenStore.getPersistedRefresh(key));
    if (tokens) {
      setSession({ orgId: tokens.orgId, userId: tokens.userId, instanceUrl: tokens.instanceUrl });
      setStatus('connected');
    } else {
      setSession(null);
      setStatus((s) => (s === 'expired' ? 'expired' : 'disconnected'));
    }
  }, []);

  useEffect(() => {
    setConnectionError(undefined);
    setApiUsage(undefined);
    setStatus('unknown');
    void loadSession(activeKey);
    // Another panel may connect/disconnect the same org.
    const onChanged = (_c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session') void loadSession(activeKey);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [activeKey, loadSession, retryKey]);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const orgRef = useRef(org);
  orgRef.current = org;

  const client = useMemo(() => {
    if (!org || !session || status !== 'connected') return null;
    const key = org.key;
    return new SalesforceClient({
      instanceUrl: session.instanceUrl,
      ...(org.apiVersion ? { apiVersion: org.apiVersion } : {}),
      getAccessToken: async () => {
        const stored = await tokenStore.get(key);
        if (stored?.authSource === 'tab-session') {
          const source = stored.sourceTabId === undefined ? undefined : await chrome.tabs.get(stored.sourceTabId).catch(() => undefined);
          if (!source?.url || parseOrgUrl(source.url)?.key !== key) {
            await tokenStore.clear(key);
            setStatus('expired');
            setSession(null);
            return undefined;
          }
        }
        let t = stored?.accessToken;
        if (!t && orgRef.current) t = (await refreshOrg(orgRef.current, settingsRef.current))?.accessToken;
        lastTokenRef.current = t;
        return t;
      },
      refresh: async () => {
        if (!orgRef.current) return undefined;
        const next = await refreshOrg(orgRef.current, settingsRef.current, lastTokenRef.current);
        if (!next) {
          setStatus('expired');
          setSession(null);
        }
        lastTokenRef.current = next?.accessToken;
        return next?.accessToken;
      },
      onUsage: setApiUsage,
    });
    // Recreate only when the org, instance, or API version changes.
  }, [org?.key, org?.apiVersion, session?.instanceUrl, status]);

  const metadata = useMemo(() => {
    if (!client || !org) return null;
    return new MetadataService(client, new MetadataCache(orgBigStore(org.key), settings.cacheTtlHours * 3600_000));
  }, [client, org?.key, settings.cacheTtlHours]);

  // After connecting: pick the newest API version and record non-secret identity details.
  useEffect(() => {
    if (!client || !org || !session) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        if (!org.apiVersion) {
          const versions = await client.versions(ctrl.signal);
          const latest = versions.map((v) => v.version).sort((a, b) => Number(b) - Number(a))[0];
          if (latest) client.apiVersion = latest;
        }
        if (ctrl.signal.aborted) return;
        const [orgResult, userResult] = await Promise.allSettled([
          client.query<{ Name: string; IsSandbox: boolean; OrganizationType: string; TrialExpirationDate: string | null }>(
            'SELECT Name, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization LIMIT 1',
            { signal: ctrl.signal },
          ),
          client.query<{ Username: string }>(`SELECT Username FROM User WHERE Id = ${soqlString(session.userId)}`, { signal: ctrl.signal }),
        ]);
        if (ctrl.signal.aborted) return;
        const orgRow = orgResult.status === 'fulfilled' ? orgResult.value : undefined;
        const userRow = userResult.status === 'fulfilled' ? userResult.value : undefined;
        const o = orgRow?.records[0];
        const user = userRow?.records[0];
        const hostEnv = page.org?.key === org.key ? page.org.environment : org.environment;
        if (o || user) {
          await profiles.updateProfile(org.key, {
            orgId: session.orgId,
            ...(o ? { orgName: o.Name, organizationType: o.OrganizationType, environment: resolveEnvironment(hostEnv, o) } : {}),
            ...(user ? { username: user.Username } : {}),
          });
        }

        // Org/user enrichment is optional. A user may be connected while lacking
        // access to one of these objects, so retain whichever result was allowed.
      } catch {
        // Identity is display-only enrichment. Session loss is normal when the
        // source tab closes, changes org, or the user disconnects mid-request.
        // Connection state and tool-level errors are handled in their own UI.
      }
    })();
    return () => ctrl.abort();
  }, [client]);

  const connect = useCallback(
    async (opts: { switchUser?: boolean; browserSession?: boolean } = {}) => {
      if (!org) return;
      setStatus('connecting');
      setConnectionError(undefined);
      try {
        if (opts.browserSession) {
          if (tab.tabId === undefined || !orgMatchesTab) throw new Error('Open the extension from the Salesforce org you want to use.');
          await connectFromSalesforceTab(org, tab.tabId);
        } else {
          await connectOrg(org, settings, opts);
        }
        await loadSession(org.key);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const kind = explainError(e).kind;
        setConnectionErrorKind(/API access|API Enabled|API_DISABLED|insufficient/i.test(msg) || kind === 'permission' ? 'denied' : kind === 'network' || e instanceof TypeError ? 'network' : 'failed');
        setConnectionError(msg);
        await loadSession(org.key);
      }
    },
    [org, settings, loadSession, tab.tabId, orgMatchesTab],
  );

  // Opening the extension is an explicit user action. If OAuth is configured,
  // immediately connect the detected org; Salesforce can reuse its signed-in
  // browser session, while still showing consent/login when policy requires it.
  useEffect(() => {
    if (!settings.autoConnect || !org || status !== 'disconnected' || tab.tabId === undefined || !orgMatchesTab) return;
    if (autoAttemptedRef.current.has(org.key)) return;
    autoAttemptedRef.current.add(org.key);
    void connect({ browserSession: true });
  }, [org, settings.autoConnect, status, tab.tabId, orgMatchesTab, connect]);

  const useSalesforceTab = useCallback(
    async (t: chrome.tabs.Tab) => {
      if (t.id === undefined) return;
      setConnectionError(undefined);
      setPinnedOrgKey(null);
      autoAttemptedRef.current.clear();
      if (source.tabId !== undefined) {
        // Workspace window: re-point it at the chosen tab and remember it in the URL.
        const next = { tabId: t.id, ...(t.windowId !== undefined ? { windowId: t.windowId } : {}) };
        setSource(next);
        const params = new URLSearchParams(location.search);
        params.set('sourceTabId', String(t.id));
        if (t.windowId !== undefined) params.set('sourceWindowId', String(t.windowId));
        window.history.replaceState(null, '', `${location.pathname}?${params}`);
      } else {
        // Side panel: it follows the active tab, so just switch to it.
        await chrome.tabs.update(t.id, { active: true });
        if (t.windowId !== undefined) await chrome.windows.update(t.windowId, { focused: true }).catch(() => undefined);
      }
    },
    [source.tabId],
  );

  const retry = useCallback(() => {
    setConnectionError(undefined);
    setConnectionErrorKind(undefined);
    autoAttemptedRef.current.clear();
    setStatus('unknown');
    setRetryKey((k) => k + 1);
  }, []);

  const disconnect = useCallback(async () => {
    if (!org) return;
    autoAttemptedRef.current.add(org.key);
    await disconnectOrg(org);
    setStatus('disconnected');
    setSession(null);
  }, [org]);

  const persistRoute = (r: Route) => {
    try {
      localStorage.setItem(ROUTE_KEY, JSON.stringify(r));
    } catch {
      // Ignore unavailable storage.
    }
  };

  const back = useCallback(() => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev) {
        setRoute(prev);
        persistRoute(prev);
      }
      return h.slice(0, -1);
    });
  }, []);

  const navigate = useCallback((r: Route, opts: { replace?: boolean } = {}) => {
    setRoute((current) => {
      const same = current.tool === r.tool && JSON.stringify(current.params ?? {}) === JSON.stringify(r.params ?? {});
      if (!opts.replace && !same) setHistory((h) => [...h, current].slice(-30));
      return r;
    });
    persistRoute(r);
    setRecentTools((current) => {
      const next = [r.tool, ...current.filter((tool) => tool !== r.tool && tool !== 'overview')].slice(0, 5);
      try { localStorage.setItem(RECENT_TOOLS_KEY, JSON.stringify(next)); } catch { /* Ignore unavailable storage. */ }
      return next;
    });
  }, []);

  const saveSettings = useCallback(async (patch: Partial<GlobalSettings>) => {
    setSettings(await profiles.saveSettings(patch));
  }, []);

  const updateOrg = useCallback(
    async (key: string, patch: Partial<OrgProfile>) => {
      await profiles.updateProfile(key, patch);
      await reloadOrgs();
    },
    [reloadOrgs],
  );

  const value: Workspace = {
    tab,
    page,
    org,
    orgs,
    pinnedOrgKey,
    orgMatchesTab,
    settings,
    status,
    ...(connectionError ? { connectionError } : {}),
    ...(connectionErrorKind ? { connectionErrorKind } : {}),
    useSalesforceTab,
    retry,
    pinnedToTab: source.tabId !== undefined,
    session,
    client,
    metadata,
    ...(apiUsage ? { apiUsage } : {}),
    route,
    theme: { scheme, accentHex, tokens: accent },
    recentTools,
    navigate,
    back,
    canGoBack: history.length > 0,
    dataVersion,
    notifyRecordChange,
    deletedIds,
    pinOrg: setPinnedOrgKey,
    connect,
    disconnect,
    saveSettings,
    updateOrg,
    reloadOrgs,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
