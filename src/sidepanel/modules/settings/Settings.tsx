/** Settings: connection, per-org names/colors (edited in a modal), appearance, privacy, and permissions. */
import { useEffect, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { OrgBadge } from '../../components/OrgBadge';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { useConfirm } from '../../components/ConfirmDialog';
import { FieldError, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toasts';
import { redirectUri } from '../../services/auth';
import { forgetOrgEverywhere, orgBigStore } from '../../services/platform';
import { MetadataCache } from '../../../shared/cache/metadataCache';
import { OAUTH_SCOPES } from '../../../shared/auth/oauth';
import { DEFAULT_ENV_COLORS, ENVIRONMENT_LABELS, type Environment } from '../../../shared/org/identity';
import { badgeColor, detectedEnvironment, displayName, effectiveEnvironment, readableTextColor, type OrgProfile, type ThemePreference } from '../../../shared/org/profiles';
import { ACCENT_PRESETS, DEFAULT_THEME, type AccentChoice, type AccentPreset } from '../../../shared/theme/accent';

const ENVS = Object.keys(ENVIRONMENT_LABELS) as Environment[];

function ConnectionSettings() {
  const ws = useWorkspace();
  const toast = useToast();
  const [clientId, setClientId] = useState(ws.settings.clientId);
  useEffect(() => setClientId(ws.settings.clientId), [ws.settings.clientId]);
  const callback = redirectUri();
  const connected = ws.status === 'connected' && ws.org;

  return (
    <section class="card stack settings-card settings-connection" aria-labelledby="conn-h">
      <h2 id="conn-h">Connection</h2>
      {connected ? (
        <div class="row">
          <span class="status-dot connected" aria-hidden="true" />
          <span class="grow">
            Connected to <strong>{displayName(ws.org!)}</strong>
            {ws.org!.username ? ` as ${ws.org!.username}` : ''}.
          </span>
          <button
            class="btn small"
            onClick={async () => {
              await ws.disconnect();
              toast({ kind: 'info', message: 'Disconnected. The workspace no longer holds your Salesforce session.' });
            }}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <p class="muted">Not connected. Open a Salesforce tab and choose Connect in the header.</p>
      )}
      <label class="check">
        <input type="checkbox" checked={ws.settings.autoConnect} onChange={(e) => void ws.saveSettings({ autoConnect: e.currentTarget.checked })} />
        Connect automatically when the workspace opens
      </label>
      <span class="hint">Uses the Salesforce session you're already signed in with in the launching tab. It's kept in memory only and discarded when Chrome closes.</span>

      <details class="subtle-details">
        <summary>Advanced: OAuth fallback</summary>
        <div class="stack">
          <p class="muted">Only needed if your org doesn't let the browser session call APIs. Create an External Client App in Salesforce Setup with these settings:</p>
          <ol class="plain">
            <li>Enable OAuth, add the callback URL below, and require PKCE.</li>
            <li>
              Scopes: <em>Manage user data via APIs</em> and <em>Perform requests at any time</em> ({OAUTH_SCOPES.join(', ')}).
            </li>
            <li>Turn off "Require secret" for the web server and refresh token flows.</li>
            <li>Save, wait a few minutes, then paste the Consumer Key here. Never paste the Consumer Secret.</li>
          </ol>
          <div class="field">
            <label for="cb-url">Callback URL</label>
            <div class="row nowrap">
              <input id="cb-url" class="mono grow" readOnly value={callback} />
              <CopyButton value={callback} label="Copy callback URL" />
            </div>
          </div>
          <form
            class="field"
            onSubmit={async (e) => {
              e.preventDefault();
              await ws.saveSettings({ clientId: clientId.trim() });
              toast({ message: clientId.trim() ? 'Consumer Key saved.' : 'Consumer Key removed.' });
            }}
          >
            <label for="client-id">Consumer Key</label>
            <div class="row nowrap">
              <input id="client-id" class="mono grow" value={clientId} autoComplete="off" spellcheck={false} onInput={(e) => setClientId(e.currentTarget.value)} />
              <button class="btn" type="submit" disabled={clientId.trim() === ws.settings.clientId}>
                Save
              </button>
            </div>
          </form>
          <label class="check">
            <input type="checkbox" checked={ws.settings.rememberConnection} onChange={(e) => void ws.saveSettings({ rememberConnection: e.currentTarget.checked })} />
            Keep OAuth sign-in after Chrome restarts
          </label>
          <span class="hint">Stores the OAuth refresh token in this Chrome profile. Leave off on shared computers.</span>
        </div>
      </details>
    </section>
  );
}

interface OrgDraft {
  label: string;
  color: string;
  useDefaultColor: boolean;
  environment: Environment | '';
  clientIdOverride: string;
  apiVersion: string;
}

function draftFor(org: OrgProfile): OrgDraft {
  const detected = detectedEnvironment(org);
  return {
    label: org.label ?? '',
    color: badgeColor(org),
    useDefaultColor: !org.color,
    environment: org.organizationType ? detected : (org.environmentOverride ?? ''),
    clientIdOverride: org.clientIdOverride ?? '',
    apiVersion: org.apiVersion ?? '',
  };
}

function OrgEditModal({ org, onClose }: { org: OrgProfile; onClose: () => void }) {
  const ws = useWorkspace();
  const toast = useToast();
  const initial = draftFor(org);
  const detected = detectedEnvironment(org);
  const [d, setD] = useState(initial);
  const labelError = d.label.length > 40 ? 'Use 40 characters or fewer.' : undefined;
  const apiError = d.apiVersion.trim() && !/^\d{2,3}\.0$/.test(d.apiVersion.trim()) ? 'Use a version like 62.0, or leave empty.' : undefined;
  const preview: OrgProfile = {
    ...org,
    ...(d.label.trim() ? { label: d.label.trim() } : { label: undefined }),
    ...(d.useDefaultColor ? { color: undefined } : { color: d.color }),
    ...(d.environment ? { environmentOverride: d.environment } : { environmentOverride: undefined }),
  };
  return (
    <Modal
      open
      title="Edit org"
      description={org.apiHost}
      dirty={JSON.stringify(d) !== JSON.stringify(initial)}
      saveDisabled={!!labelError || !!apiError}
      onClose={onClose}
      onSave={async () => {
        await ws.updateOrg(org.key, {
          label: d.label.trim() || undefined,
          color: d.useDefaultColor ? undefined : d.color,
          environmentOverride: !d.environment || d.environment === detected ? undefined : d.environment,
          clientIdOverride: d.clientIdOverride.trim() || undefined,
          apiVersion: d.apiVersion.trim() || undefined,
        });
        toast({ message: `Saved changes to ${displayName(preview)}.` });
      }}
    >
      <div class="row">
        <span class="subtle">Preview</span>
        <OrgBadge org={preview} />
      </div>
      <div class="field">
        <label for="oe-label">Display name</label>
        <input id="oe-label" autoFocus value={d.label} placeholder={org.orgName ?? org.myDomain} aria-invalid={!!labelError} aria-describedby={labelError ? 'oe-label-err' : 'oe-label-hint'} onInput={(e) => { const v = e.currentTarget.value; setD((prev) => ({ ...prev, label: v })); }} />
        <FieldError id="oe-label-err" message={labelError} />
        {!labelError && (
          <span id="oe-label-hint" class="hint">
            Shown in the badge, e.g. "ACME UAT". Leave empty to use the org's name.
          </span>
        )}
      </div>
      <div class="field">
        <label for="oe-env">Environment</label>
        <select id="oe-env" value={d.environment} onChange={(e) => { const v = e.currentTarget.value as Environment | ''; setD((prev) => ({ ...prev, environment: v })); }}>
          {org.organizationType ? (
            <option value={detected}>Detected from {org.organizationType} ({ENVIRONMENT_LABELS[detected]})</option>
          ) : (
            <option value="">Detect automatically ({ENVIRONMENT_LABELS[detected]})</option>
          )}
          {ENVS.filter((e) => e !== 'unknown' && (!org.organizationType || e !== detected)).map((env) => (
            <option key={env} value={env}>
              {ENVIRONMENT_LABELS[env]}
            </option>
          ))}
        </select>
        <span class="hint">{org.organizationType ? `Salesforce reports ${org.organizationType}; ${ENVIRONMENT_LABELS[detected]} is selected automatically. Choose another value only to override it.` : 'The environment is detected from the Salesforce hostname.'}</span>
      </div>
      <div class="field">
        <span id="oe-color-label" class="label-like">
          Badge color
        </span>
        <div class="row">
          <label class="check">
            <input type="checkbox" checked={d.useDefaultColor} onChange={(e) => { const v = e.currentTarget.checked; setD((prev) => ({ ...prev, useDefaultColor: v })); }} /> Use the environment's default color
          </label>
          {!d.useDefaultColor && <input type="color" aria-labelledby="oe-color-label" value={d.color} onInput={(e) => { const v = e.currentTarget.value; setD((prev) => ({ ...prev, color: v })); }} />}
        </div>
      </div>
      <details class="subtle-details">
        <summary>Advanced</summary>
        <div class="stack">
          <div class="field">
            <label for="oe-client">Consumer Key for this org (OAuth fallback)</label>
            <input id="oe-client" class="mono" value={d.clientIdOverride} placeholder="Uses the global Consumer Key" onInput={(e) => { const v = e.currentTarget.value; setD((prev) => ({ ...prev, clientIdOverride: v })); }} />
          </div>
          <div class="field">
            <label for="oe-api">API version</label>
            <input id="oe-api" class="mono" value={d.apiVersion} placeholder="Newest the org supports" aria-invalid={!!apiError} aria-describedby={apiError ? 'oe-api-err' : undefined} onInput={(e) => { const v = e.currentTarget.value; setD((prev) => ({ ...prev, apiVersion: v })); }} />
            <FieldError id="oe-api-err" message={apiError} />
          </div>
        </div>
      </details>
    </Modal>
  );
}

function OrgSettings() {
  const ws = useWorkspace();
  const toast = useToast();
  const [confirm, confirmEl] = useConfirm();
  const [editing, setEditing] = useState<OrgProfile | null>(null);
  return (
    <section class="card stack settings-card settings-orgs" aria-labelledby="orgs-h">
      {confirmEl}
      <h2 id="orgs-h">Orgs</h2>
      {ws.orgs.length === 0 ? (
        <p class="muted">Orgs appear here after you open them in a Salesforce tab.</p>
      ) : (
        <ul class="list">
          {ws.orgs.map((o) => {
            const active = ws.org?.key === o.key;
            return (
              <li key={o.key}>
                <div class="grow stack" style={{ gap: 2 }}>
                  <div class="row">
                    <OrgBadge org={o} />
                    {active && <span class="pill info">In use</span>}
                    {o.organizationType && <span class="pill">{o.organizationType}</span>}
                  </div>
                  <span class="subtle break">
                    Environment: {ENVIRONMENT_LABELS[effectiveEnvironment(o)]} · {o.username ?? o.apiHost}
                  </span>
                </div>
                {!active && (
                  <button class="btn small" onClick={() => ws.pinOrg(o.key)}>
                    Use
                  </button>
                )}
                <button class="btn small" onClick={() => setEditing(o)}>
                  <Icon name="edit" /> Edit
                </button>
                <details class="menu">
                  <summary class="icon-btn" aria-label={`More actions for ${displayName(o)}`} title="More actions">
                    ⋯
                  </summary>
                  <div class="menu-list">
                    <button
                      class="btn small ghost"
                      onClick={async () => {
                        await new MetadataCache(orgBigStore(o.key), 0).invalidate();
                        toast({ message: `Cleared cached objects and fields for ${displayName(o)}.` });
                      }}
                    >
                      Clear cached metadata
                    </button>
                    <button
                      class="btn small ghost danger"
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Forget ${displayName(o)}?`,
                          body: 'Removes its connection, saved items, cached metadata, SOQL history, and test sessions from this browser. Nothing in Salesforce changes.',
                          confirmLabel: 'Forget org',
                          danger: true,
                        });
                        if (!ok) return;
                        if (active && ws.status === 'connected') await ws.disconnect();
                        await forgetOrgEverywhere(o.key);
                        if (ws.pinnedOrgKey === o.key) ws.pinOrg(null);
                        await ws.reloadOrgs();
                        toast({ kind: 'info', message: `${displayName(o)} removed from this browser.` });
                      }}
                    >
                      Forget this org…
                    </button>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <p class="subtle">Each org's settings, saved items, caches, and test sessions are stored separately.</p>
      {editing && <OrgEditModal org={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

const MODES: Array<[ThemePreference, string]> = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['contrast', 'High contrast'],
];

function AppearanceSettings() {
  const ws = useWorkspace();
  const toast = useToast();
  const { settings, theme } = ws;
  const orgColor = ws.org ? badgeColor(ws.org) : undefined;
  const swatches: Array<[AccentChoice, string, string]> = [
    ['org', ws.org ? `Match org badge (${displayName(ws.org)})` : 'Match org badge', orgColor ?? ACCENT_PRESETS.blue.hex],
    ...(Object.entries(ACCENT_PRESETS) as Array<[AccentPreset, { label: string; hex: string }]>).map(([k, v]) => [k, v.label, v.hex] as [AccentChoice, string, string]),
  ];
  const isDefault = settings.theme === DEFAULT_THEME.mode && settings.accent === DEFAULT_THEME.accent;
  return (
    <section class="card stack settings-card settings-appearance" aria-labelledby="appearance-h">
      <div class="card-title">
        <h2 id="appearance-h">Appearance</h2>
        <button
          class="btn small"
          disabled={isDefault}
          onClick={async () => {
            await ws.saveSettings({ theme: DEFAULT_THEME.mode, accent: DEFAULT_THEME.accent });
            toast({ message: 'Appearance reset to System mode with your org badge color.' });
          }}
        >
          <Icon name="refresh" /> Reset to default
        </button>
      </div>
      <div class="field">
        <span id="mode-label" class="label-like">
          Mode
        </span>
        <div class="segmented" role="radiogroup" aria-labelledby="mode-label">
          {MODES.map(([value, label]) => (
            <button key={value} type="button" role="radio" aria-checked={settings.theme === value} onClick={() => void ws.saveSettings({ theme: value })}>
              {label}
            </button>
          ))}
        </div>
        {settings.theme === 'system' && <span class="hint">Follows your computer's light/dark setting (now {theme.scheme === 'dark' ? 'dark' : 'light'}).</span>}
      </div>
      <div class="field">
        <span id="accent-label" class="label-like">
          Accent color
        </span>
        <div class="swatches" role="radiogroup" aria-labelledby="accent-label">
          {swatches.map(([value, label, hex]) => (
            <button key={value} type="button" role="radio" aria-checked={settings.accent === value} class="swatch" title={label} aria-label={label} onClick={() => void ws.saveSettings({ accent: value })}>
              <span class="swatch-dot" style={{ background: hex }} aria-hidden="true">
                {value === 'org' && <span class="swatch-org">ORG</span>}
              </span>
            </button>
          ))}
        </div>
        <span class="hint">
          {swatches.find(([v]) => v === settings.accent)?.[1]}.{' '}
          {theme.tokens.adjusted === 'destructive'
            ? 'This color is close to the red used for Delete, so a nearby shade is used to keep destructive actions distinct.'
            : theme.tokens.adjusted === 'readability'
              ? 'Adjusted slightly so text and links stay readable in this mode.'
              : 'Used for buttons, links, tabs, selections, and focus outlines.'}
        </span>
      </div>
      <div class="theme-preview" aria-label="Live preview" role="group">
        <span class="section-label">Live preview</span>
        <div class="subnav" aria-hidden="true">
          <span class="preview-tab active">Active tab</span>
          <span class="preview-tab">Tab</span>
        </div>
        <div class="row">
          <button type="button" class="btn primary small" tabIndex={-1}>
            <Icon name="check" /> Primary
          </button>
          <button type="button" class="btn small" tabIndex={-1}>
            Secondary
          </button>
          <button type="button" class="btn small" tabIndex={-1} disabled>
            Disabled
          </button>
          <button type="button" class="btn danger small" tabIndex={-1}>
            <Icon name="trash" /> Delete
          </button>
        </div>
        <div class="row">
          <a href="#appearance-h" tabIndex={-1} onClick={(e) => e.preventDefault()}>
            A link
          </a>
          <span class="pill selected">Selected</span>
          <label class="check">
            <input type="checkbox" checked tabIndex={-1} readOnly /> Checked
          </label>
          <span class="preview-focus">Focus ring</span>
        </div>
      </div>
    </section>
  );
}

function GeneralSettings() {
  const ws = useWorkspace();
  return (
    <section class="card stack settings-card settings-data" aria-labelledby="gen-h">
      <h2 id="gen-h">Data & records</h2>
      <div class="field">
        <label for="ttl">Keep object and field info for</label>
        <select id="ttl" value={String(ws.settings.cacheTtlHours)} onChange={(e) => void ws.saveSettings({ cacheTtlHours: Number(e.currentTarget.value) })}>
          <option value="1">1 hour</option>
          <option value="8">8 hours</option>
          <option value="24">1 day</option>
          <option value="168">1 week</option>
        </select>
        <span class="hint">Use Refresh in Objects & fields to update sooner.</span>
      </div>
      <label class="check">
        <input type="checkbox" checked={ws.settings.allowRecordChanges} onChange={(e) => void ws.saveSettings({ allowRecordChanges: e.currentTarget.checked })} />
        Allow creating, editing, and deleting records
      </label>
      <span class="hint">Turn off to use the workspace for viewing only. Your Salesforce permissions always apply either way.</span>
      <label class="check">
        <input type="checkbox" checked={ws.settings.redactEmailsInExports} onChange={(e) => void ws.saveSettings({ redactEmailsInExports: e.currentTarget.checked })} />
        Hide email addresses in exported bug reports
      </label>
      <details class="subtle-details">
        <summary>Default badge colors</summary>
        <div class="row">
          {ENVS.map((e) => (
            <span key={e} class="pill" style={{ background: DEFAULT_ENV_COLORS[e], color: readableTextColor(DEFAULT_ENV_COLORS[e]), borderColor: 'transparent' }}>
              {ENVIRONMENT_LABELS[e]}
            </span>
          ))}
        </div>
      </details>
    </section>
  );
}

function PrivacyInfo() {
  return (
    <section class="card stack settings-card settings-privacy" aria-labelledby="priv-h">
      <h2 id="priv-h">Privacy</h2>
      <ul class="plain">
        <li>Salesforce data goes only between this browser and your org's Salesforce domain. No analytics or third-party servers.</li>
        <li>Records are created, edited, or deleted only when you choose Save or confirm Delete, and only where your Salesforce permissions allow. Metadata is never changed.</li>
        <li>Flow and deployment error explanations run locally with built-in rules.</li>
        <li>Your password is never read, and session credentials are never shown, logged, or exported.</li>
      </ul>
      <details class="subtle-details">
        <summary>Why each Chrome permission is needed</summary>
        <dl class="kv">
          <dt>Salesforce sites</dt>
          <dd>Recognize the org and page in your tab and call Salesforce APIs on your My Domain.</dd>
          <dt>cookies</dt>
          <dd>Reuse your signed-in Salesforce session (Salesforce cookies only) so you don't sign in twice.</dd>
          <dt>tabs</dt>
          <dd>Follow the Salesforce tab you launched from and stop access if it switches org.</dd>
          <dt>storage</dt>
          <dd>Save settings, org names and colors, saved items, and test sessions in this browser.</dd>
          <dt>activeTab</dt>
          <dd>Let "Capture tab" take a screenshot when you ask it to.</dd>
          <dt>identity</dt>
          <dd>Complete the optional OAuth sign-in.</dd>
          <dt>sidePanel</dt>
          <dd>Offer the workspace in Chrome's side panel as well as its own window.</dd>
        </dl>
      </details>
    </section>
  );
}

export function Settings() {
  return (
    <>
      <div class="settings-grid">
        <ConnectionSettings />
        <OrgSettings />
        <AppearanceSettings />
        <GeneralSettings />
        <PrivacyInfo />
      </div>
      <p class="subtle settings-version">Salesforce Workspace v{chrome.runtime.getManifest().version}. Not affiliated with or endorsed by Salesforce, Inc.</p>
    </>
  );
}
