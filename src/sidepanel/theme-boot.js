/* global localStorage, window, document */
// Runs synchronously before first paint (see sidepanel.html) so the saved theme
// is applied before any UI renders. The workspace writes `sfw:theme` whenever the
// theme or accent changes; see state/workspace.tsx and shared/theme/bootTheme.ts.
(function () {
  try {
    var raw = localStorage.getItem('sfw:theme');
    if (!raw) return;
    var saved = JSON.parse(raw);
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var scheme = saved.mode === 'system' ? (dark ? 'dark' : 'light') : saved.mode;
    var vars = saved.vars && saved.vars[scheme];
    var root = document.documentElement;
    root.setAttribute('data-theme', scheme);
    if (vars) for (var k in vars) root.style.setProperty(k, vars[k]);
  } catch {
    /* Storage unavailable: the CSS defaults (and prefers-color-scheme) apply. */
  }
})();
