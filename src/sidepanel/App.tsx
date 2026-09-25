import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { useWorkspace } from './state/workspace';
import { SECTIONS, toolMeta, toolsIn, type SectionId, type ToolId } from './state/routes';
import { OrgBadge, EnvStrip } from './components/OrgBadge';
import { ToolSearch } from './components/ToolSearch';
import { Icon } from './components/Icon';
import { PAGE_TYPE_LABELS } from '../shared/context/pageContext';
import { displayName } from '../shared/org/profiles';
import { Overview } from './modules/overview/Overview';
import { RecordSearch } from './modules/records/RecordSearch';
import { RecordNavigator } from './modules/records/RecordNavigator';
import { AccessExplainer } from './modules/access/AccessExplainer';
import { Users } from './modules/users/Users';
import { FlowErrorTranslator } from './modules/flows/FlowErrorTranslator';
import { FormTester } from './modules/flows/FormTester';
import { SoqlWorkspace } from './modules/development/SoqlWorkspace';
import { DebugLogs } from './modules/development/DebugLogs';
import { DeployAssistant } from './modules/development/DeployAssistant';
import { ApexClassesExplorer, ApexTriggersExplorer, FlowsExplorer } from './modules/development/CodeExplainer';
import { ObjectExplorer } from './modules/metadata/ObjectExplorer';
import { FieldMapping } from './modules/metadata/FieldMapping';
import { Dependencies } from './modules/metadata/Dependencies';
import { Settings } from './modules/settings/Settings';
import { DataImport } from './modules/dataTransfer/DataImport';
import { DataExport } from './modules/dataTransfer/DataExport';

const TOOL_COMPONENTS: Record<ToolId, () => JSX.Element> = {
  overview: Overview,
  recordSearch: RecordSearch,
  record: RecordNavigator,
  dataImport: DataImport,
  dataExport: DataExport,
  users: Users,
  access: AccessExplainer,
  flowErrors: FlowErrorTranslator,
  formTester: FormTester,
  soql: SoqlWorkspace,
  apexClasses: ApexClassesExplorer,
  apexTriggers: ApexTriggersExplorer,
  flowsExplorer: FlowsExplorer,
  debugLogs: DebugLogs,
  deploy: DeployAssistant,
  objects: ObjectExplorer,
  mapping: FieldMapping,
  dependencies: Dependencies,
  settings: Settings,
};

function OrgSwitcher() {
  const ws = useWorkspace();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabOrg = ws.page.org ? (ws.orgs.find((o) => o.key === ws.page.org!.key) ?? null) : null;

  const options = [
    { key: '', label: tabOrg ? `This tab (${displayName(tabOrg)})` : 'Follow the Salesforce tab' },
    ...ws.orgs.map((o) => ({ key: o.key, label: displayName(o) })),
  ];
  const selectedKey = ws.pinnedOrgKey ?? '';
  const selected = options.find((o) => o.key === selectedKey) ?? options[0]!;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (ws.orgs.length < 2 && !ws.pinnedOrgKey) return null;

  const show = () => {
    const index = Math.max(0, options.findIndex((o) => o.key === selectedKey));
    setActive(index);
    setOpen(true);
    setTimeout(() => optionRefs.current[index]?.focus());
  };
  const choose = (key: string) => {
    ws.pinOrg(key || null);
    setOpen(false);
    rootRef.current?.querySelector<HTMLButtonElement>('.org-switcher-trigger')?.focus();
  };
  const onOptionKeyDown = (event: KeyboardEvent) => {
    let next = active;
    if (event.key === 'ArrowDown') next = (active + 1) % options.length;
    else if (event.key === 'ArrowUp') next = (active - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault(); setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>('.org-switcher-trigger')?.focus(); return;
    } else if (event.key === 'Tab') { setOpen(false); return; }
    else return;
    event.preventDefault(); setActive(next); optionRefs.current[next]?.focus();
  };
  return (
    <div class={`org-switcher ${open ? 'open' : ''}`} ref={rootRef}>
      <button
        type="button"
        class="org-switcher-trigger"
        aria-label="Choose the org tools use"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => open ? setOpen(false) : show()}
        onKeyDown={(event) => {
          if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show(); }
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <span class="ellipsis">{selected.label}</span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div class="org-switcher-menu" role="listbox" aria-label="Salesforce orgs">
          {options.map((option, index) => (
            <button
              key={option.key || 'follow-tab'}
              type="button"
              role="option"
              aria-selected={option.key === selectedKey}
              class={index === active ? 'active' : undefined}
              ref={(element) => { optionRefs.current[index] = element; }}
              onFocus={() => setActive(index)}
              onKeyDown={onOptionKeyDown}
              onClick={() => choose(option.key)}
            >
              <span class="org-option-check" aria-hidden="true">{option.key === selectedKey ? '✓' : ''}</span>
              <span class="ellipsis">{option.label}</span>
              {option.key === '' && <span class="org-option-hint">Auto</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionChip() {
  const ws = useWorkspace();
  if (!ws.org) return null;
  if (ws.status === 'connected') {
    return (
      <span class="conn-chip ok" title={ws.org.username ? `Connected as ${ws.org.username}` : 'Connected'}>
        <span class="status-dot connected" aria-hidden="true" />
        <span class="ellipsis">{ws.org.username ?? 'Connected'}</span>
      </span>
    );
  }
  const label = ws.status === 'connecting' ? 'Connecting…' : ws.status === 'expired' ? 'Session expired' : ws.status === 'unknown' ? 'Checking…' : 'Not connected';
  const canConnect = ws.orgMatchesTab && ws.tab.tabId !== undefined && ws.status !== 'connecting' && ws.status !== 'unknown';
  return (
    <button class={`conn-chip ${ws.status === 'expired' ? 'bad' : ''}`} disabled={!canConnect} onClick={() => void ws.connect({ browserSession: true })} title={canConnect ? 'Connect using your signed-in Salesforce session' : label}>
      <span class={`status-dot ${ws.status}`} aria-hidden="true" />
      <span>{label}</span>
      {canConnect && <strong>Connect</strong>}
    </button>
  );
}

function Header() {
  const ws = useWorkspace();
  return (
    <header class="header">
      <EnvStrip org={ws.org} />
      <div class="header-row">
        <div class="header-org">
          {ws.org ? <OrgBadge org={ws.org} /> : <span class="pill">No Salesforce org</span>}
          <ConnectionChip />
          <OrgSwitcher />
        </div>
        <ToolSearch />
      </div>
      {ws.pinnedOrgKey && ws.page.org && ws.pinnedOrgKey !== ws.page.org.key && (
        <div class="header-note" role="note">
          <Icon name="info" /> Tools use the org you picked, not the one in the Salesforce tab.
          <button class="link-button" onClick={() => ws.pinOrg(null)}>
            Follow the tab
          </button>
        </div>
      )}
    </header>
  );
}

/** Opens a section at its most useful tool for the current page. */
function defaultTool(section: SectionId, hasRecord: boolean): ToolId {
  if (section === 'records' && hasRecord) return 'record';
  return toolsIn(section)[0]!.id;
}

function Nav() {
  const ws = useWorkspace();
  const current = toolMeta(ws.route.tool).section;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const hasRecord = ws.orgMatchesTab && !!ws.page.recordId;
  const go = (section: SectionId) => ws.navigate({ tool: defaultTool(section, hasRecord) });

  // On the narrow bottom bar the active section can be off-screen; bring it into view.
  useEffect(() => {
    if (!window.matchMedia('(max-width: 700px)').matches) return;
    const index = SECTIONS.findIndex((s) => s.id === current);
    refs.current[index]?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, [current]);

  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const vertical = window.matchMedia('(min-width: 701px)').matches;
    let next = -1;
    if (e.key === (vertical ? 'ArrowDown' : 'ArrowRight')) next = (i + 1) % SECTIONS.length;
    else if (e.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) next = (i - 1 + SECTIONS.length) % SECTIONS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = SECTIONS.length - 1;
    if (next >= 0) {
      e.preventDefault();
      refs.current[next]?.focus();
    }
  };

  return (
    <nav class="nav" aria-label="Sections">
      <div class="nav-brand" aria-hidden="true">
        <span class="brand-mark">S</span>
        <span>SF Workspace</span>
      </div>
      <ul class="nav-list">
        {SECTIONS.map((s, i) => (
          <li key={s.id}>
            <button
              ref={(el) => {
                refs.current[i] = el;
              }}
              aria-current={current === s.id ? 'page' : undefined}
              onClick={() => go(s.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              title={s.label}
              aria-label={s.label}
            >
              <Icon name={s.icon} />
              <span class="nav-label-full">{s.label}</span>
              <span class="nav-label-short" aria-hidden="true">{s.short ?? s.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function PageHeader() {
  const ws = useWorkspace();
  const meta = toolMeta(ws.route.tool);
  const section = SECTIONS.find((s) => s.id === meta.section)!;
  const tools = toolsIn(meta.section);
  return (
    <div class="page-header">
      <div class="page-title-row">
        {ws.canGoBack && ws.route.tool !== 'overview' && (
          <button class="icon-btn back-btn" onClick={ws.back} aria-label="Back to the previous screen" title="Back">
            <Icon name="back" />
          </button>
        )}
        <div class="grow">
          {section.label !== meta.label && <div class="breadcrumb">{section.label}</div>}
          <h1>{meta.label}</h1>
        </div>
      </div>
      <p class="page-desc">{meta.description}</p>
      {tools.length > 1 && (
        <div class="subnav" role="tablist" aria-label={`${section.label} tools`}>
          {tools.map((t) => (
            <button key={t.id} role="tab" aria-selected={ws.route.tool === t.id} onClick={() => ws.navigate({ tool: t.id })}>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Footer() {
  const ws = useWorkspace();
  const u = ws.apiUsage;
  return (
    <footer class="app-footer" aria-label="Page context">
      <span>
        {ws.page.isSalesforce ? PAGE_TYPE_LABELS[ws.page.pageType] : 'Not a Salesforce tab'}
        {ws.orgMatchesTab && ws.page.objectApiName ? ` · ${ws.page.objectApiName}` : ''}
      </span>
      {u && (
        <span title="Daily API requests used by this org (from Salesforce's usage header)">
          API {u.used.toLocaleString()} / {u.max.toLocaleString()}
        </span>
      )}
    </footer>
  );
}

export function App() {
  const ws = useWorkspace();
  const Tool = TOOL_COMPONENTS[ws.route.tool];
  return (
    <div class="workspace-shell">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <Nav />
      <div class="workspace-body">
        <Header />
        <main id="main" tabIndex={-1}>
          <PageHeader />
          <Tool key={`${ws.route.tool}:${ws.org?.key ?? 'none'}`} />
        </main>
        <Footer />
      </div>
    </div>
  );
}
