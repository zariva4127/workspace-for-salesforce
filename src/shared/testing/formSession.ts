/**
 * Guided form test sessions: steps with expected/actual results and screenshots,
 * stored per org, exportable as a readable bug report.
 *
 * Exports contain only what the tester entered plus sanitized page URLs.
 * Tokens are never part of a session; text fields are still passed through
 * `redact` in case a tester pastes something sensitive.
 */
import { redact, sanitizeUrl } from '../security/redact';
import type { OrgScopedStore } from '../storage/kv';

export type StepStatus = 'pending' | 'pass' | 'fail' | 'blocked';

export interface TestStep {
  id: string;
  action: string;
  expected: string;
  actual: string;
  status: StepStatus;
  notes: string;
  pageUrl?: string;
  screenshotIds: string[];
  createdAt: number;
}

export interface TestSession {
  id: string;
  title: string;
  description: string;
  /** Org label and environment at the time of the test, for the report header. */
  orgLabel: string;
  environment: string;
  tester?: string;
  createdAt: number;
  updatedAt: number;
  steps: TestStep[];
}

export interface Screenshot {
  id: string;
  dataUrl: string;
  caption: string;
  capturedAt: number;
}

export function newId(prefix: string): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${Date.now().toString(36)}${rand[0]!.toString(36)}${rand[1]!.toString(36)}`;
}

export function emptyStep(pageUrl?: string): TestStep {
  return {
    id: newId('step'),
    action: '',
    expected: '',
    actual: '',
    status: 'pending',
    notes: '',
    ...(pageUrl ? { pageUrl: sanitizeUrl(pageUrl) } : {}),
    screenshotIds: [],
    createdAt: Date.now(),
  };
}

export function sessionStats(s: TestSession): Record<StepStatus, number> {
  const stats: Record<StepStatus, number> = { pending: 0, pass: 0, fail: 0, blocked: 0 };
  for (const step of s.steps) stats[step.status]++;
  return stats;
}

export function overallResult(s: TestSession): 'Passed' | 'Failed' | 'Blocked' | 'In progress' | 'Empty' {
  const st = sessionStats(s);
  if (!s.steps.length) return 'Empty';
  if (st.fail) return 'Failed';
  if (st.blocked) return 'Blocked';
  if (st.pending) return 'In progress';
  return 'Passed';
}

/** Persists sessions and screenshots in the org's own namespace. */
export class SessionRepository {
  constructor(private readonly store: OrgScopedStore) {}

  async list(): Promise<TestSession[]> {
    const keys = await this.store.keys('session:');
    const sessions = await Promise.all(keys.map((k) => this.store.get<TestSession>(k)));
    return sessions.filter((s): s is TestSession => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string) {
    return this.store.get<TestSession>(`session:${id}`);
  }
  async save(session: TestSession): Promise<TestSession> {
    const next = { ...session, updatedAt: Date.now() };
    await this.store.set(`session:${session.id}`, next);
    return next;
  }
  async delete(session: TestSession): Promise<void> {
    for (const step of session.steps) for (const id of step.screenshotIds) await this.store.remove(`shot:${id}`);
    await this.store.remove(`session:${session.id}`);
  }
  saveScreenshot(shot: Screenshot) {
    return this.store.set(`shot:${shot.id}`, shot);
  }
  getScreenshot(id: string) {
    return this.store.get<Screenshot>(`shot:${id}`);
  }
  removeScreenshot(id: string) {
    return this.store.remove(`shot:${id}`);
  }
}

export interface ReportOptions {
  redactEmails: boolean;
  includeUrls: boolean;
  includeScreenshots: boolean;
}

const STATUS_LABEL: Record<StepStatus, string> = { pending: 'Not run', pass: 'Pass', fail: 'Fail', blocked: 'Blocked' };

function clean(text: string, opts: ReportOptions): string {
  return redact(text, { emails: opts.redactEmails });
}

export function toMarkdown(session: TestSession, opts: ReportOptions): string {
  const c = (t: string) => clean(t, opts);
  const st = sessionStats(session);
  const lines = [
    `# ${c(session.title || 'Untitled test')}`,
    '',
    `- **Result:** ${overallResult(session)} (${st.pass} passed, ${st.fail} failed, ${st.blocked} blocked, ${st.pending} not run)`,
    `- **Org:** ${c(session.orgLabel)} (${session.environment})`,
    ...(session.tester ? [`- **Tester:** ${c(session.tester)}`] : []),
    `- **Date:** ${new Date(session.createdAt).toLocaleString()}`,
    '',
  ];
  if (session.description.trim()) lines.push('## Description', '', c(session.description), '');
  lines.push('## Steps', '');
  session.steps.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${c(s.action) || '(no action)'} — ${STATUS_LABEL[s.status]}`, '');
    lines.push(`**Expected:** ${c(s.expected) || '—'}`, '', `**Actual:** ${c(s.actual) || '—'}`, '');
    if (s.notes.trim()) lines.push(`**Notes:** ${c(s.notes)}`, '');
    if (opts.includeUrls && s.pageUrl) lines.push(`**Page:** ${sanitizeUrl(s.pageUrl)}`, '');
    if (s.screenshotIds.length) lines.push(`_${s.screenshotIds.length} screenshot(s) — included in the HTML report._`, '');
  });
  lines.push('---', '_Generated by Salesforce Workspace. Access tokens are never included; text was scanned for secrets._');
  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function toHtml(session: TestSession, shots: Map<string, Screenshot>, opts: ReportOptions): string {
  const c = (t: string) => esc(clean(t, opts));
  const st = sessionStats(session);
  const result = overallResult(session);
  const steps = session.steps
    .map((s, i) => {
      const imgs = opts.includeScreenshots
        ? s.screenshotIds
            .map((id) => shots.get(id))
            .filter((x): x is Screenshot => !!x && x.dataUrl.startsWith('data:image/'))
            .map((x) => `<figure><img src="${x.dataUrl}" alt="${c(x.caption || `Step ${i + 1} screenshot`)}"><figcaption>${c(x.caption)}</figcaption></figure>`)
            .join('')
        : '';
      return `<section class="step ${s.status}">
<h3>${i + 1}. ${c(s.action) || '(no action)'} <span class="badge">${STATUS_LABEL[s.status]}</span></h3>
<dl><dt>Expected</dt><dd>${c(s.expected) || '—'}</dd><dt>Actual</dt><dd>${c(s.actual) || '—'}</dd>
${s.notes.trim() ? `<dt>Notes</dt><dd>${c(s.notes)}</dd>` : ''}
${opts.includeUrls && s.pageUrl ? `<dt>Page</dt><dd>${esc(sanitizeUrl(s.pageUrl))}</dd>` : ''}</dl>${imgs}</section>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${c(session.title || 'Test report')}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#181818}
.step{border:1px solid #ddd;border-left-width:6px;border-radius:6px;padding:.5rem 1rem;margin:1rem 0}
.pass{border-left-color:#2e844a}.fail{border-left-color:#ba0517}.blocked{border-left-color:#a96404}.pending{border-left-color:#888}
.badge{font-size:12px;background:#eee;border-radius:10px;padding:2px 8px;margin-left:6px}
dt{font-weight:600}dd{margin:0 0 .5rem;white-space:pre-wrap}img{max-width:100%;border:1px solid #ccc;border-radius:4px}
figcaption{font-size:12px;color:#555}footer{color:#666;font-size:12px;margin-top:2rem}</style></head><body>
<h1>${c(session.title || 'Untitled test')}</h1>
<p><strong>Result:</strong> ${result} — ${st.pass} passed, ${st.fail} failed, ${st.blocked} blocked, ${st.pending} not run<br>
<strong>Org:</strong> ${c(session.orgLabel)} (${esc(session.environment)})<br>
${session.tester ? `<strong>Tester:</strong> ${c(session.tester)}<br>` : ''}<strong>Date:</strong> ${esc(new Date(session.createdAt).toLocaleString())}</p>
${session.description.trim() ? `<h2>Description</h2><p style="white-space:pre-wrap">${c(session.description)}</p>` : ''}
<h2>Steps</h2>${steps}
<footer>Generated by Salesforce Workspace. Access tokens are never included; text was scanned for secrets.</footer></body></html>`;
}
