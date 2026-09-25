/** Deployment error assistant: paste Salesforce CLI output, get grouped failures with explanations. Fully local. */
import { useMemo, useState } from 'preact/hooks';
import { Alert, EmptyState } from '../../components/States';
import { CopyButton } from '../../components/CopyButton';
import { groupByCategory, parseDeployOutput, type ComponentFailure, type DeployAnalysis } from '../../../shared/parsers/deployErrors';
import { redact } from '../../../shared/security/redact';

const SAMPLE = `Status: Failed

Component Failures [3]
 Type   Name              Problem                                                  Line:Column
 ────── ───────────────── ──────────────────────────────────────────────────────── ───────────
 Error  InvoiceService    No such column 'Tier__c' on entity 'Account'.            12:30
 Error  InvoiceController Dependent class is invalid and needs recompilation       1:1
 Error  force-app/main/default/lwc/invoiceCard/invoiceCard.js  LWC1503: Invalid reference @salesforce/apex/InvoiceService.get of type module

Average test coverage across all Apex Classes and Triggers is 68%, at least 75% test coverage is required.`;

function location(f: ComponentFailure): string {
  if (f.line === undefined) return '';
  return f.column !== undefined ? `line ${f.line}, col ${f.column}` : `line ${f.line}`;
}

function summaryMarkdown(a: DeployAnalysis): string {
  const lines = [`Deployment analysis: ${a.failures.length} component failure(s), ${a.testFailures.length} test failure(s)`];
  for (const g of groupByCategory(a.failures)) {
    lines.push('', `## ${g.category}`);
    for (const f of g.items) lines.push(`- ${f.componentType ?? ''} ${f.fullName ?? f.fileName ?? ''} ${location(f) ? `(${location(f)})` : ''}: ${f.problem}`);
  }
  for (const t of a.testFailures) lines.push(`- Test ${t.name}${t.methodName ? `.${t.methodName}` : ''}: ${t.message}`);
  if (a.coverage.average !== undefined) lines.push('', `Average coverage: ${a.coverage.average}%`);
  return redact(lines.join('\n'));
}

export function DeployAssistant() {
  const [input, setInput] = useState('');
  const analysis = useMemo(() => parseDeployOutput(input), [input]);
  const groups = useMemo(() => groupByCategory(analysis.failures), [analysis]);
  const hasResults = analysis.failures.length || analysis.testFailures.length || analysis.coverage.warnings.length || analysis.coverage.average !== undefined || analysis.topLevelError;

  return (
    <>
      <section class="card stack narrow">
        <div class="field">
          <label for="deploy-in">Paste Salesforce CLI deploy output</label>
          <span class="hint">
            Works with <code>sf project deploy start/report</code> (with or without <code>--json</code>), legacy <code>sfdx force:source:deploy</code>, and Metadata API output. Parsed locally — nothing is sent anywhere.
          </span>
          <textarea id="deploy-in" class="code" rows={8} value={input} onInput={(e) => setInput(e.currentTarget.value)} spellcheck={false} />
        </div>
        <div class="row">
          <button class="btn small" onClick={() => setInput(SAMPLE)}>
            Load example
          </button>
          <button class="btn small" onClick={() => setInput('')} disabled={!input}>
            Clear
          </button>
          <span class="grow" />
          {hasResults ? <CopyButton value={summaryMarkdown(analysis)} label="Copy summary" /> : null}
        </div>
      </section>

      {analysis.format === 'empty' ? (
        <EmptyState title="Nothing to analyze yet">
          <p>Paste the full output of a failed deployment or validation.</p>
        </EmptyState>
      ) : !hasResults ? (
        <Alert kind="info" title="No failures recognized">
          The text didn't contain component failures, test failures, or coverage results in a known format. Try running the command with <code>--json</code> and pasting that output.
        </Alert>
      ) : (
        <>
          <section class="card stack" aria-labelledby="deploy-sum">
            <h2 id="deploy-sum">Summary</h2>
            <div class="row">
              {analysis.status && <span class={`pill ${/succeed/i.test(analysis.status) ? 'ok' : 'error'}`}>{analysis.status}</span>}
              <span class="pill">{analysis.failures.length} component failure(s)</span>
              <span class="pill">{analysis.testFailures.length} test failure(s)</span>
              {analysis.coverage.average !== undefined && (
                <span class={`pill ${analysis.coverage.average >= 75 ? 'ok' : 'error'}`}>Coverage {analysis.coverage.average}%</span>
              )}
              <span class="pill info">{analysis.format === 'json' ? 'JSON' : 'Text'} input</span>
            </div>
            {analysis.topLevelError && <Alert kind="error" title="CLI error">{analysis.topLevelError}</Alert>}
            {analysis.notes.map((n) => (
              <Alert key={n} kind="warning">
                {n}
              </Alert>
            ))}
          </section>

          {groups.map((g) => {
            const d = g.items[0]!.diagnosis;
            return (
              <section key={g.category} class="card stack" aria-label={g.category}>
                <div class="card-title">
                  <h2>{g.category}</h2>
                  <span class="pill">{g.items.length}</span>
                </div>
                <p class="muted">{d.explanation}</p>
                <ul class="list">
                  {g.items.map((f, i) => (
                    <li key={i}>
                      <div class="grow stack" style={{ gap: 2 }}>
                        <div class="row">
                          <span class={`pill ${f.problemType === 'Warning' ? 'warning' : 'error'}`}>{f.problemType}</span>
                          {f.componentType && <span class="subtle">{f.componentType}</span>}
                          <strong class="break">{f.fullName ?? f.fileName}</strong>
                          {location(f) && <span class="subtle">{location(f)}</span>}
                        </div>
                        <div class="break">{f.problem}</div>
                        {f.diagnosis.explanation !== d.explanation && <div class="subtle">{f.diagnosis.explanation}</div>}
                        {f.fileName && f.fileName !== f.fullName && <code class="subtle break">{f.fileName}</code>}
                      </div>
                    </li>
                  ))}
                </ul>
                <details open={groups.length <= 2}>
                  <summary>How to fix</summary>
                  <ul class="plain">
                    {[...new Set(g.items.flatMap((f) => f.diagnosis.suggestions))].map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </details>
              </section>
            );
          })}

          {analysis.testFailures.length > 0 && (
            <section class="card stack" aria-labelledby="tests-h">
              <h2 id="tests-h">Test failures</h2>
              <ul class="list">
                {analysis.testFailures.map((t, i) => (
                  <li key={i}>
                    <div class="grow stack" style={{ gap: 2 }}>
                      <strong class="break">
                        {t.name}
                        {t.methodName ? `.${t.methodName}` : ''}
                      </strong>
                      <div class="break">{t.message}</div>
                      {t.stackTrace && <pre class="log">{t.stackTrace}</pre>}
                      <div class="subtle">{t.diagnosis.suggestions[0]}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {analysis.coverage.warnings.length > 0 && (
            <section class="card stack" aria-labelledby="cov-h">
              <h2 id="cov-h">Code coverage warnings</h2>
              <ul class="plain">
                {analysis.coverage.warnings.map((w) => (
                  <li key={w} class="break">
                    {w}
                  </li>
                ))}
              </ul>
              <p class="subtle">Production deployments need 75% overall coverage and some coverage on every trigger.</p>
            </section>
          )}
        </>
      )}
    </>
  );
}
