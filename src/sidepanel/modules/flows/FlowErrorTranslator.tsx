/** Flow error translator: rule-based, local explanation of pasted flow errors. */
import { Fragment } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { Alert, EmptyState } from '../../components/States';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { translateFlowError, type FlowErrorAnalysis } from '../../../shared/parsers/flowError';
import { redact } from '../../../shared/security/redact';

const SAMPLE = `Error element Update_Account (FlowRecordUpdate).
The flow tried to update these records: 001000000000001AAA. This error occurred: FIELD_CUSTOM_VALIDATION_EXCEPTION: Industry is required for customers. You can look up ExceptionCode values in the SOAP API Developer Guide.

Flow Details
Flow API Name: Account_After_Save
Type: Record-Triggered Flow
Version: 3
Status: Active

Flow Interview Details
Interview GUID: 8f1c2d3e4b5a6978-1a2b
Current User: Jane Doe (005000000000001AAA)`;

function toText(a: FlowErrorAnalysis): string {
  const lines = ['Flow error analysis'];
  if (a.flowApiName || a.flowLabel) lines.push(`Flow: ${a.flowLabel ?? ''} ${a.flowApiName ? `(${a.flowApiName})` : ''}`.trim());
  if (a.elementName) lines.push(`Failing element: ${a.elementName} (${a.elementTypeLabel})`);
  for (const i of a.issues) {
    lines.push('', `${i.title} [${i.code}]`, i.explanation, 'Possible causes:', ...i.causes.map((c) => `- ${c}`), 'Verify:', ...i.verify.map((v) => `- ${v}`));
  }
  return redact(lines.join('\n'));
}

export function FlowErrorTranslator() {
  const ws = useWorkspace();
  const [input, setInput] = useState('');
  const a = useMemo(() => translateFlowError(input), [input]);
  const details: Array<[string, string | undefined]> = [
    ['Flow', a.flowLabel && a.flowApiName ? `${a.flowLabel} (${a.flowApiName})` : (a.flowLabel ?? a.flowApiName)],
    ['Version', a.flowVersion],
    ['Flow type', a.flowType],
    ['Failing element', a.elementName ? `${a.elementName} — ${a.elementTypeLabel}` : undefined],
    ['Interview GUID', a.interviewGuid],
    ['Error ID', a.errorId],
    ['Running user', a.currentUser],
    ['Org ID', a.orgId],
  ];
  const shown = details.filter(([, v]) => v);

  return (
    <>
      <section class="card stack narrow">
        <div class="field">
          <label for="flow-in">Paste a flow error</label>
          <span class="hint">A flow fault email, the error shown on a screen flow, or a "We can't save this record" message. Explained locally with built-in rules.</span>
          <textarea id="flow-in" class="code" rows={8} value={input} spellcheck={false} onInput={(e) => setInput(e.currentTarget.value)} />
        </div>
        <div class="row">
          <button class="btn small" onClick={() => setInput(SAMPLE)}>
            Load example
          </button>
          <button class="btn small" onClick={() => setInput('')} disabled={!input}>
            Clear
          </button>
          <span class="grow" />
          {!a.empty && <CopyButton value={toText(a)} label="Copy explanation" />}
        </div>
      </section>

      {a.empty ? (
        <EmptyState title="Nothing to explain yet">
          <p>Paste the error text above. Include the whole email if you have it — details like the element name make the explanation more precise.</p>
        </EmptyState>
      ) : (
        <>
          {a.uncertain && (
            <Alert kind="warning" title="Low confidence">
              {a.issues.length
                ? 'The message is generic and does not include the underlying cause. The steps below help you find it.'
                : 'No known error pattern was recognized. The general steps below still apply.'}
            </Alert>
          )}
          {shown.length > 0 && (
            <section class="card" aria-labelledby="fe-details">
              <h2 id="fe-details">Extracted details</h2>
              <dl class="kv">
                {shown.map(([k, v]) => (
                  <Fragment key={k}>
                    <dt>{k}</dt>
                    <dd class="break">{v}</dd>
                  </Fragment>
                ))}
                {a.recordIds.length > 0 && (
                  <>
                    <dt>Records</dt>
                    <dd>
                      {a.recordIds.map((id) => (
                        <div key={id} class="row nowrap">
                          <code>{id}</code>
                          <CopyButton value={id} label={`Copy ${id}`} />
                          <button class="icon-btn" onClick={() => ws.navigate({ tool: 'record', params: { recordId: id } })} aria-label={`Inspect ${id}`}><Icon name="record" /></button>
                        </div>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}
          {a.issues.map((i) => (
            <section key={i.code} class="card stack" aria-label={i.title}>
              <div class="card-title">
                <h2>{i.title}</h2>
                <code class="subtle">{i.code}</code>
              </div>
              <p>{i.explanation}</p>
              <div>
                <h3>Possible causes</h3>
                <ul class="plain">
                  {i.causes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>How to verify</h3>
                <ul class="plain">
                  {i.verify.map((v) => (
                    <li key={v}>{v}</li>
                  ))}
                </ul>
              </div>
              <details>
                <summary>Matched text</summary>
                <pre class="log">{i.evidence}</pre>
              </details>
            </section>
          ))}
          <section class="card stack" aria-labelledby="fe-general">
            <h2 id="fe-general">General troubleshooting</h2>
            <ul class="plain">
              {a.generalSteps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {ws.org && (
              <div class="row">
                <button class="btn small" onClick={() => ws.navigate({ tool: 'debugLogs' })}>
                  Debug logs
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
