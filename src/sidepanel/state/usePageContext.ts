/**
 * Tracks the active tab in the side panel's window and derives its page context.
 *
 * Lightning Experience is a single-page app: moving between records changes the
 * URL with history.pushState. Chrome reports those changes via tabs.onUpdated
 * (changeInfo.url), so context updates without a page refresh. Tab URLs are only
 * visible for hosts in host_permissions, i.e. Salesforce domains.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { detectPageContext, sameContext, type PageContext } from '../../shared/context/pageContext';

export interface ActiveTab {
  ctx: PageContext;
  tabId?: number;
  windowId?: number;
  loading: boolean;
}

/** The Salesforce tab the workspace window was opened from (or switched to). */
export interface SourceTab {
  tabId?: number;
  windowId?: number;
}

export function sourceTabFromUrl(): SourceTab {
  const params = new URLSearchParams(location.search);
  const num = (v: string | null) => {
    const n = v === null ? NaN : Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const tabId = num(params.get('sourceTabId'));
  const windowId = num(params.get('sourceWindowId'));
  return { ...(tabId !== undefined ? { tabId } : {}), ...(windowId !== undefined ? { windowId } : {}) };
}

export function usePageContext(source: SourceTab, retryKey = 0): ActiveTab {
  const [state, setState] = useState<ActiveTab>({ ctx: detectPageContext(undefined), loading: true });
  const windowIdRef = useRef<number | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    const sourceTabId = source.tabId;
    const sourceWindowId = source.windowId;
    if (sourceWindowId !== undefined) windowIdRef.current = sourceWindowId;
    setState((prev) => ({ ...prev, loading: true }));

    const apply = (tab: chrome.tabs.Tab | undefined) => {
      if (disposed) return;
      const ctx = detectPageContext(tab?.url ?? tab?.pendingUrl);
      setState((prev) =>
        !prev.loading && prev.tabId === tab?.id && sameContext(prev.ctx, ctx) && prev.ctx.url === ctx.url
          ? prev
          : { ctx, ...(tab?.id !== undefined ? { tabId: tab.id } : {}), ...(windowIdRef.current !== undefined ? { windowId: windowIdRef.current } : {}), loading: false },
      );
    };

    const refresh = () => {
      clearTimeout(timer.current);
      // Debounce bursts of events during Lightning navigation.
      timer.current = setTimeout(async () => {
        try {
          if (sourceTabId !== undefined) {
            apply(await chrome.tabs.get(sourceTabId));
            return;
          }
          const query: chrome.tabs.QueryInfo = windowIdRef.current !== undefined ? { active: true, windowId: windowIdRef.current } : { active: true, currentWindow: true };
          const [tab] = await chrome.tabs.query(query);
          apply(tab);
        } catch {
          apply(undefined);
        }
      }, 120);
    };

    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (sourceTabId !== undefined) return;
      if (windowIdRef.current === undefined || info.windowId === windowIdRef.current) refresh();
    };
    const onUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (sourceTabId !== undefined && id !== sourceTabId) return;
      if (!tab.active || (windowIdRef.current !== undefined && tab.windowId !== windowIdRef.current)) return;
      if (change.url || change.status === 'complete') refresh();
    };
    const onFocus = (windowId: number) => {
      if (windowId === windowIdRef.current) refresh();
    };

    if (sourceTabId !== undefined) refresh();
    else {
      chrome.windows
        .getCurrent()
        .then((w) => {
          windowIdRef.current = w.id;
        })
        .catch(() => undefined)
        .finally(refresh);
    }

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onFocusChanged.addListener(onFocus);
    return () => {
      disposed = true;
      clearTimeout(timer.current);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onFocusChanged.removeListener(onFocus);
    };
  }, [source.tabId, source.windowId, retryKey]);

  return state;
}
