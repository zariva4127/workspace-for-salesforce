/**
 * Guided form tester. Records test steps with expected/actual results and
 * screenshots, stored locally per org, and exports a readable bug report.
 * Works without an API connection.
 */
import { SearchInput } from '../../components/SearchInput';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { Alert, EmptyState } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useConfirm } from '../../components/ConfirmDialog';
import { FieldError, Modal } from '../../components/Modal';
import { useToast } from '../../components/Toasts';
import { copyText } from '../../components/CopyButton';
import { orgBigStore } from '../../services/platform';
import { downloadText, safeFilename } from '../../utils/download';
import {
  SessionRepository,
  emptyStep,
  newId,
  overallResult,
  sessionStats,
  toHtml,
  toMarkdown,
  type Screenshot,
  type StepStatus,
  type TestSession,
  type TestStep,
} from '../../../shared/testing/formSession';
import { sanitizeUrl } from '../../../shared/security/redact';
import { ENVIRONMENT_LABELS } from '../../../shared/org/identity';
import { displayName, effectiveEnvironment } from '../../../shared/org/profiles';

/** Namespace for sessions recorded while no org is selected. Cannot collide with a real org key. */
const UNSCOPED_KEY = 'unscoped.local';
const MAX_SHOT_BYTES = 6 * 1024 * 1024;

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function ShotThumb({ id, repo, onRemove }: { id: string; repo: SessionRepository; onRemove: () => void }) {
  const [shot, setShot] = useState<Screenshot>();
  useEffect(() => {
    void repo.getScreenshot(id).then(setShot);
  }, [id, repo]);
  if (!shot) return null;
  return (
    <figure>
      <img src={shot.dataUrl} alt={shot.caption || 'Screenshot'} title={shot.caption} />
      <button class="icon-btn" onClick={onRemove} aria-label="Remove screenshot">
        <Icon name="close" />
      </button>
    </figure>
  );
}

const STATUSES: Array<{ value: StepStatus; label: string }> = [
  { value: 'pending', label: 'Not run' },
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'blocked', label: 'Blocked' },
];

function StepEditor({
  step,
  index,
  total,
  repo,
  onChange,
  onMove,
  onDelete,
}: {
  step: TestStep;
  index: number;
  total: number;
  repo: SessionRepository;
  /** Applies a change to the latest version of this step. */
  onChange: (patch: (s: TestStep) => Partial<TestStep>) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const ws = useWorkspace();
  const [shotError, setShotError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);
  const idp = `step-${step.id}`;

  const addShot = async (dataUrl: string, caption: string) => {
    if (!dataUrl.startsWith('data:image/')) return setShotError('Only images can be attached.');
    if (dataUrl.length > MAX_SHOT_BYTES * 1.37) return setShotError('Image is too large (max 6 MB).');
    const shot: Screenshot = { id: newId('shot'), dataUrl, caption, capturedAt: Date.now() };
    await repo.saveScreenshot(shot);
    onChange((s) => ({ screenshotIds: [...s.screenshotIds, shot.id] }));
    setShotError(undefined);
  };

  const capture = async () => {
    try {
      const windowId = ws.tab.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 75 });
      await addShot(dataUrl, `Step ${index + 1}`);
    } catch {
      setShotError(
        'Chrome only allows capturing a tab right after you open the extension from its toolbar icon (or Alt+Shift+S) on that tab. Reopen it that way, or paste (Ctrl/Cmd+V) or upload a screenshot instead.',
      );
    }
  };

  const onPaste = async (e: ClipboardEvent) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    await addShot(await readAsDataUrl(file), `Step ${index + 1} (pasted)`);
  };

  return (
    <li class={`step stack ${step.status}`} onPaste={onPaste} aria-label={`Step ${index + 1}`}>
      <div class="row">
        <strong class="grow">Step {index + 1}</strong>
        <label class="visually-hidden" for={`${idp}-status`}>
          Result
        </label>
        <select id={`${idp}-status`} style={{ width: 'auto' }} value={step.status} onChange={(e) => { const v = e.currentTarget.value as StepStatus; onChange(() => ({ status: v })); }}>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button class="icon-btn" onClick={() => onMove(-1)} disabled={index === 0} aria-label="Move step up">
          ↑
        </button>
        <button class="icon-btn" onClick={() => onMove(1)} disabled={index === total - 1} aria-label="Move step down">
          ↓
        </button>
        <button class="icon-btn" onClick={onDelete} aria-label="Delete step">
          <Icon name="trash" />
        </button>
      </div>
      <div class="field">
        <label for={`${idp}-action`}>Action</label>
        <input id={`${idp}-action`} value={step.action} placeholder="e.g. Enter a Close Date in the past and click Save" onInput={(e) => { const v = e.currentTarget.value; onChange(() => ({ action: v })); }} />
      </div>
      <div class="step-grid">
      <div class="field">
        <label for={`${idp}-exp`}>Expected result</label>
        <textarea id={`${idp}-exp`} rows={2} value={step.expected} onInput={(e) => { const v = e.currentTarget.value; onChange(() => ({ expected: v })); }} />
      </div>
      <div class="field">
        <label for={`${idp}-act`}>Actual result</label>
        <textarea id={`${idp}-act`} rows={2} value={step.actual} onInput={(e) => { const v = e.currentTarget.value; onChange(() => ({ actual: v })); }} />
      </div>
      </div>
      <details>
        <summary>Notes & page</summary>
        <div class="stack">
          <textarea aria-label="Notes" rows={2} value={step.notes} onInput={(e) => { const v = e.currentTarget.value; onChange(() => ({ notes: v })); }} />
          <div class="subtle break">Page: {step.pageUrl ?? 'not recorded'}</div>
          {ws.page.url && ws.page.isSalesforce && (
            <button class="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => onChange(() => ({ pageUrl: sanitizeUrl(ws.page.url!) }))}>
              Use current page
            </button>
          )}
        </div>
      </details>
      <div class="row">
        <button class="btn small" onClick={capture}>
          <Icon name="camera" /> Capture tab
        </button>
        <button class="btn small" onClick={() => fileRef.current?.click()}>
          Upload image
        </button>
        <span class="subtle">or paste an image here</span>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.currentTarget.files?.[0];
            if (f) await addShot(await readAsDataUrl(f), f.name);
            e.currentTarget.value = '';
          }}
        />
      </div>
      {shotError && <Alert kind="warning">{shotError}</Alert>}
      {step.screenshotIds.length > 0 && (
        <div class="shots">
          {step.screenshotIds.map((id) => (
            <ShotThumb
              key={id}
              id={id}
              repo={repo}
              onRemove={async () => {
                await repo.removeScreenshot(id);
                onChange((s) => ({ screenshotIds: s.screenshotIds.filter((x) => x !== id) }));
              }}
            />
          ))}
        </div>
      )}
    </li>
  );
}

function ExportPanel({ session, repo }: { session: TestSession; repo: SessionRepository }) {
  const ws = useWorkspace();
  const [includeUrls, setIncludeUrls] = useState(true);
  const [includeShots, setIncludeShots] = useState(true);
  const [msg, setMsg] = useState<string>();
  const opts = { redactEmails: ws.settings.redactEmailsInExports, includeUrls, includeScreenshots: includeShots };
  const base = safeFilename(`${session.title || 'test'}-${new Date(session.createdAt).toISOString().slice(0, 10)}`);

  const exportHtml = async () => {
    const shots = new Map<string, Screenshot>();
    for (const s of session.steps) for (const id of s.screenshotIds) {
      const shot = await repo.getScreenshot(id);
      if (shot) shots.set(id, shot);
    }
    downloadText(`${base}.html`, toHtml(session, shots, opts), 'text/html');
  };

  return (
    <section class="card stack" aria-labelledby="export-h">
      <h2 id="export-h">Export bug report</h2>
      <label class="check">
        <input type="checkbox" checked={includeUrls} onChange={(e) => setIncludeUrls(e.currentTarget.checked)} /> Include page URLs (query strings removed)
      </label>
      <label class="check">
        <input type="checkbox" checked={includeShots} onChange={(e) => setIncludeShots(e.currentTarget.checked)} /> Include screenshots (HTML only)
      </label>
      <p class="subtle">
        Reports never contain access tokens. Text is scanned for session IDs and tokens{ws.settings.redactEmailsInExports ? ', and email addresses are redacted' : ''}. Review screenshots
        before sharing — they show whatever was on screen.
      </p>
      <div class="row">
        <button class="btn primary" onClick={exportHtml}>
          <Icon name="download" /> HTML report
        </button>
        <button class="btn" onClick={() => downloadText(`${base}.md`, toMarkdown(session, opts), 'text/markdown')}>
          Markdown
        </button>
        <button
          class="btn"
          onClick={async () => {
            setMsg((await copyText(toMarkdown(session, opts))) ? 'Copied Markdown to clipboard.' : 'Copy failed.');
            setTimeout(() => setMsg(undefined), 2000);
          }}
        >
          <Icon name="copy" /> Copy
        </button>
      </div>
      <div aria-live="polite" class="subtle">
        {msg}
      </div>
    </section>
  );
}

interface SessionDetails {
  title: string;
  description: string;
  tester: string;
}

/** New/Edit test details. Title is required; closing with edits asks before discarding. */
function SessionDetailsModal({ open, initial, isNew, onSave, onClose }: { open: boolean; initial: SessionDetails; isNew: boolean; onSave: (d: SessionDetails) => Promise<void>; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setD(initial);
      setTouched(false);
    }
  }, [open]);
  const titleError = !d.title.trim() ? 'Give the test a title so you can find it later.' : d.title.length > 120 ? 'Use 120 characters or fewer.' : undefined;
  const dirty = d.title !== initial.title || d.description !== initial.description || d.tester !== initial.tester;
  return (
    <Modal
      open={open}
      title={isNew ? 'New test session' : 'Edit test details'}
      description={isNew ? 'You can add steps, results, and screenshots next.' : undefined}
      saveLabel={isNew ? 'Create test' : 'Save'}
      dirty={dirty}
      onClose={onClose}
      onSave={async () => {
        setTouched(true);
        if (titleError) return false;
        await onSave({ title: d.title.trim(), description: d.description.trim(), tester: d.tester.trim() });
      }}
    >
      <div class="field">
        <label for="t-title">Title</label>
        <input
          id="t-title"
          autoFocus
          value={d.title}
          placeholder="e.g. Opportunity close validation"
          aria-invalid={touched && !!titleError}
          aria-describedby={touched && titleError ? 't-title-err' : undefined}
          onInput={(e) => { const v = e.currentTarget.value; setD((prev) => ({ ...prev, title: v })); }}
          onBlur={() => setTouched(true)}
        />
        <FieldError id="t-title-err" message={touched ? titleError : undefined} />
      </div>
      <div class="field">
        <label for="t-desc">Description or preconditions (optional)</label>
        <textarea id="t-desc" rows={3} value={d.description} onInput={(e) => { const v = e.currentTarget.value; setD((prev) => ({ ...prev, description: v })); }} />
      </div>
      <div class="field">
        <label for="t-tester">Tester (optional)</label>
        <input id="t-tester" value={d.tester} onInput={(e) => { const v = e.currentTarget.value; setD((prev) => ({ ...prev, tester: v })); }} />
      </div>
    </Modal>
  );
}

export function FormTester() {
  const ws = useWorkspace();
  const toast = useToast();
  const orgKey = ws.org?.key ?? UNSCOPED_KEY;
  const repo = useMemo(() => new SessionRepository(orgBigStore(orgKey)), [orgKey]);
  const [sessions, setSessions] = useState<TestSession[] | null>(null);
  const [current, setCurrent] = useState<TestSession | null>(null);
  const [modal, setModal] = useState<'new' | 'edit' | null>(null);
  const [filter, setFilter] = useState('');
  const [confirm, confirmEl] = useConfirm();
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();

  const reload = async () => setSessions(await repo.list());
  useEffect(() => {
    setCurrent(null);
    void reload();
  }, [repo]);

  // Debounced auto-save for step edits.
  const update = (fn: (s: TestSession) => TestSession) => {
    setCurrent((prev) => {
      if (!prev) return prev;
      const next = fn(prev);
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void repo.save(next), 400);
      return next;
    });
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const create = async (d: SessionDetails) => {
    const env = ws.org ? ENVIRONMENT_LABELS[effectiveEnvironment(ws.org)] : 'No org';
    const s: TestSession = {
      id: newId('session'),
      title: d.title,
      description: d.description,
      ...(d.tester ? { tester: d.tester } : {}),
      orgLabel: ws.org ? displayName(ws.org) : 'No org selected',
      environment: env,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [emptyStep(ws.page.isSalesforce ? ws.page.url : undefined)],
    };
    setCurrent(await repo.save(s));
    toast({ message: `Created “${d.title}”.` });
  };

  const detailsModal = (
    <SessionDetailsModal
      open={modal !== null}
      isNew={modal === 'new'}
      initial={modal === 'edit' && current ? { title: current.title, description: current.description, tester: current.tester ?? '' } : { title: '', description: '', tester: '' }}
      onClose={() => setModal(null)}
      onSave={async (d) => {
        if (modal === 'new') await create(d);
        else if (current) {
          const next = { ...current, title: d.title, description: d.description, tester: d.tester };
          clearTimeout(saveTimer.current);
          setCurrent(await repo.save(next));
          toast({ message: 'Test details saved.' });
        }
      }}
    />
  );

  if (!current) {
    const t = filter.trim().toLowerCase();
    const shown = (sessions ?? []).filter((s) => !t || `${s.title} ${s.description}`.toLowerCase().includes(t));
    return (
      <>
        {confirmEl}
        {detailsModal}
        <section class="card stack">
          <div class="card-title">
            <h2>Test sessions</h2>
            <button class="btn primary" onClick={() => setModal('new')}>
              <Icon name="plus" /> New test
            </button>
          </div>
          {sessions && sessions.length > 4 && <SearchInput placeholder="Filter tests" label="Filter tests" value={filter} onValue={setFilter} />}
          {sessions === null ? (
            <div class="skeleton" />
          ) : sessions.length === 0 ? (
            <EmptyState title="No test sessions yet">
              <p>Record steps, expected and actual results, and screenshots while you test a form, then export a bug report.</p>
            </EmptyState>
          ) : shown.length === 0 ? (
            <p class="muted">No tests match “{filter}”.</p>
          ) : (
            <ul class="result-list">
              {shown.map((s) => {
                const st = sessionStats(s);
                const res = overallResult(s);
                return (
                  <li key={s.id}>
                    <button class="result-main" onClick={() => setCurrent(s)}>
                      <strong>{s.title || 'Untitled test'}</strong>
                      <span>
                        {new Date(s.updatedAt).toLocaleString()} · {s.steps.length} step{s.steps.length === 1 ? '' : 's'} · {st.pass} passed, {st.fail} failed
                      </span>
                    </button>
                    <span class={`pill ${res === 'Passed' ? 'pass' : res === 'Failed' ? 'fail' : res === 'Blocked' ? 'blocked' : ''}`}>{res}</span>
                    <button
                      class="icon-btn"
                      aria-label={`Delete ${s.title || 'untitled test'}`}
                      title="Delete"
                      onClick={async () => {
                        if (await confirm({ title: 'Delete test session?', body: `"${s.title || 'Untitled test'}" and its screenshots will be removed from this browser.`, confirmLabel: 'Delete', danger: true })) {
                          await repo.delete(s);
                          await reload();
                          toast({ kind: 'info', message: 'Test session deleted.' });
                        }
                      }}
                    >
                      <Icon name="trash" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p class="subtle">Saved in this browser only, separately for each org{ws.org ? '' : ' (no org selected)'}.</p>
        </section>
      </>
    );
  }

  const setStep = (id: string, patch: (s: TestStep) => Partial<TestStep>) => update((cur) => ({ ...cur, steps: cur.steps.map((s) => (s.id === id ? { ...s, ...patch(s) } : s)) }));
  const moveStep = (i: number, dir: -1 | 1) =>
    update((cur) => {
      const steps = [...cur.steps];
      const [s] = steps.splice(i, 1);
      steps.splice(i + dir, 0, s!);
      return { ...cur, steps };
    });

  return (
    <>
      {confirmEl}
      {detailsModal}
      <section class="card stack">
        <div class="record-head">
          <button
            class="icon-btn"
            aria-label="Back to all test sessions"
            title="All test sessions"
            onClick={async () => {
              clearTimeout(saveTimer.current);
              await repo.save(current);
              setCurrent(null);
              await reload();
            }}
          >
            <Icon name="back" />
          </button>
          <div class="grow">
            <h2 class="break">{current.title || 'Untitled test'}</h2>
            <div class="subtle">
              {current.orgLabel} ({current.environment}){current.tester ? ` · Tester: ${current.tester}` : ''}
            </div>
          </div>
          <span class={`pill ${overallResult(current) === 'Passed' ? 'pass' : overallResult(current) === 'Failed' ? 'fail' : ''}`}>{overallResult(current)}</span>
          <button class="btn small" onClick={() => setModal('edit')}>
            <Icon name="edit" /> Edit details
          </button>
        </div>
        {current.description && <p class="muted" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{current.description}</p>}
      </section>
      <ol class="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Test steps">
        {current.steps.map((s, i) => (
          <StepEditor
            key={s.id}
            step={s}
            index={i}
            total={current.steps.length}
            repo={repo}
            onChange={(patch) => setStep(s.id, patch)}
            onMove={(d) => moveStep(i, d)}
            onDelete={async () => {
              if (await confirm({ title: `Delete step ${i + 1}?`, body: 'The step and its screenshots will be removed.', confirmLabel: 'Delete', danger: true })) {
                for (const id of s.screenshotIds) await repo.removeScreenshot(id);
                update((cur) => ({ ...cur, steps: cur.steps.filter((x) => x.id !== s.id) }));
              }
            }}
          />
        ))}
      </ol>
      <div class="row">
        <button class="btn" onClick={() => update((cur) => ({ ...cur, steps: [...cur.steps, emptyStep(ws.page.isSalesforce ? ws.page.url : undefined)] }))}>
          <Icon name="plus" /> Add step
        </button>
        <span class="subtle">Changes to steps save automatically.</span>
      </div>
      <ExportPanel session={current} repo={repo} />
    </>
  );
}
