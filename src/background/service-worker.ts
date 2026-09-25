/** Opens the workspace in a dedicated Chrome window from the toolbar action. */

async function configure(): Promise<void> {
  // The manifest still declares the side panel so Chrome's side-panel menu can
  // offer it, but the primary toolbar action is a standalone workspace window.
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
}

chrome.action.onClicked.addListener((tab) => {
  const page = new URL(chrome.runtime.getURL('sidepanel.html'));
  if (tab.id !== undefined) page.searchParams.set('sourceTabId', String(tab.id));
  if (tab.windowId !== undefined) page.searchParams.set('sourceWindowId', String(tab.windowId));
  void chrome.windows.create({
    url: page.toString(),
    type: 'popup',
    width: 520,
    height: 820,
    focused: true,
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void configure();
});

chrome.runtime.onStartup.addListener(() => {
  void configure();
});
