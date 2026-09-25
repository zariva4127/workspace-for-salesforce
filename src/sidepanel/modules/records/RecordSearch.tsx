/**
 * Record search: paste an ID to open it directly, or search by name, number,
 * or email with SOSL. With an empty box it shows what you recently viewed in
 * Salesforce. All results run as the connected user (sharing and FLS apply).
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { ConnectionGate } from '../../components/ConnectionGate';
import { EmptyState, ErrorAlert, Loading } from '../../components/States';
import { ObjectPicker, useObjects } from '../../components/Pickers';
import { SearchInput } from '../../components/SearchInput';
import { NewRecordButton } from './NewRecordButton';
import { Icon } from '../../components/Icon';
import { useAsync } from '../../hooks/useAsync';
import { DEFAULT_SEARCH_OBJECTS, classifySearchInput, recentlyViewed, searchRecords, targetFor, type SearchHit, type SearchTarget } from '../../../shared/salesforce/search';
import { recordUrl } from '../../../shared/salesforce/links';
import { objectLabel } from '../../../shared/salesforce/metadata';

function ResultRow({ id, title, subtitle, objectApiName }: { id: string; title: string; subtitle?: string; objectApiName: string }) {
  const ws = useWorkspace();
  return (
    <li>
      <button class="result-main" onClick={() => ws.navigate({ tool: 'record', params: { recordId: id } })}>
        <strong>{title}</strong>
        <span>
          {objectApiName}
          {subtitle ? ` · ${subtitle}` : ''}
        </span>
      </button>
      <a class="icon-btn" href={recordUrl(ws.org!, objectApiName, id)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${title} in Salesforce`} title="Open in Salesforce">
        <Icon name="external" />
      </a>
    </li>
  );
}

function Search() {
  const ws = useWorkspace();
  const objects = useObjects();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [objectName, setObjectName] = useState('');
  const [submitted, setSubmitted] = useState<{ term: string; object: string } | null>(null);
  const [touched, setTouched] = useState(false);
  const input = classifySearchInput(text);

  useEffect(() => inputRef.current?.focus(), []);

  const targets = useMemo<SearchTarget[] | null>(() => {
    if (!submitted) return null;
    if (!submitted.object) return DEFAULT_SEARCH_OBJECTS;
    return [targetFor({ name: submitted.object }, 'Name')];
  }, [submitted]);

  const search = useAsync<SearchHit[]>(
    submitted && targets && ws.client
      ? async (signal) => {
          // For a chosen object, find its real name field (e.g. CaseNumber) from describe.
          let t = targets;
          if (submitted.object && ws.metadata && !DEFAULT_SEARCH_OBJECTS.some((d) => d.name === submitted.object)) {
            const d = await ws.metadata.describe(submitted.object, { signal });
            const nameField = d.value.fields.find((f) => f.nameField)?.name ?? 'Id';
            t = [{ name: submitted.object, nameField }];
          }
          return searchRecords(ws.client!, submitted.term, t, signal);
        }
      : null,
    [submitted, ws.client, ws.dataVersion],
  );

  useEffect(() => {
    setSubmitted((s) => (s && s.object !== objectName ? { ...s, object: objectName } : s));
  }, [objectName]);

  const recent = useAsync(ws.client ? (signal) => recentlyViewed(ws.client!, objectName || undefined, signal) : null, [ws.client, objectName, ws.dataVersion]);
  const notDeleted = (id: string) => !ws.deletedIds.has(id.slice(0, 15));

  const onSubmit = (e: Event) => {
    e.preventDefault();
    setTouched(true);
    if (input.kind === 'id') ws.navigate({ tool: 'record', params: { recordId: input.id } });
    else if (input.kind === 'text') setSubmitted({ term: input.term, object: objectName });
  };

  const selectedObject = objects.data?.value.find((o) => o.name === objectName);
  const objectNotSearchable = selectedObject && !selectedObject.searchable;

  return (
    <>
      <form class="card stack narrow" onSubmit={onSubmit} role="search" aria-label="Find records">
        <div class="field">
          <label for="rs-term">Search</label>
          <div class="row">
            <SearchInput
              inputRef={inputRef}
              id="rs-term"
              class="grow"
              label="Search records"
              value={text}
              placeholder="Name, number, email, or ID"
              aria-invalid={touched && input.kind === 'invalid'}
              aria-describedby="rs-help"
              onValue={(v) => {
                setText(v);
                if (!v) {
                  setSubmitted(null);
                  setTouched(false);
                }
              }}
            />
            <button class="btn primary" type="submit" disabled={!!objectNotSearchable}>
              {input.kind === 'id' ? 'Open record' : 'Search'}
            </button>
          </div>
          <span id="rs-help" class={touched && input.kind === 'invalid' ? 'field-error' : 'hint'}>
            {touched && input.kind === 'invalid' ? input.reason : input.kind === 'id' ? 'That looks like a record ID — press Enter to open it.' : 'Searches Accounts, Contacts, Leads, Opportunities, Cases, and Users unless you pick an object.'}
          </span>
        </div>
        <ObjectPicker id="rs-object" label="Only this object (optional)" value={objectName} onChange={setObjectName} objects={objects.data?.value} />
        {objectNotSearchable && <span class="field-error">{objectLabel(selectedObject)} isn't searchable. Use the SOQL workspace instead.</span>}
        {selectedObject && (
          <div class="row">
            <NewRecordButton objectApiName={selectedObject.name} objectLabel={objectLabel(selectedObject)} createable={selectedObject.createable} />
          </div>
        )}
      </form>

      {submitted ? (
        <section class="card stack" aria-labelledby="rs-results-h" aria-busy={search.loading}>
          <div class="card-title">
            <h2 id="rs-results-h">
              Results for “{submitted.term}”{submitted.object ? ` in ${submitted.object}` : ''}
            </h2>
            <button
              class="btn small ghost"
              onClick={() => {
                setSubmitted(null);
                setText('');
                inputRef.current?.focus();
              }}
            >
              Clear search
            </button>
          </div>
          {search.loading ? (
            <Loading label="Searching…" />
          ) : search.error ? (
            <ErrorAlert error={search.error} onRetry={search.run} />
          ) : search.data && search.data.length === 0 ? (
            <EmptyState title="No matching records" icon="search">
              <p>Check the spelling, try fewer words, or pick a specific object. Search only shows records shared with you, and new records can take a few minutes to become searchable.</p>
            </EmptyState>
          ) : (
            <ul class="result-list">
              {search.data?.filter((h) => notDeleted(h.id)).map((h) => <ResultRow key={h.id} id={h.id} title={h.title} objectApiName={h.objectApiName} {...(h.subtitle ? { subtitle: h.subtitle } : {})} />)}
            </ul>
          )}
        </section>
      ) : (
        <section class="card stack" aria-labelledby="rs-recent-h">
          <div class="card-title">
            <h2 id="rs-recent-h">Recently viewed{objectName ? ` · ${objectName}` : ''}</h2>
            <button class="btn small" onClick={recent.run} disabled={recent.loading}>
              <Icon name="refresh" /> Refresh
            </button>
          </div>
          {recent.loading ? (
            <Loading label="Loading recent records…" />
          ) : recent.error ? (
            <ErrorAlert error={recent.error} onRetry={recent.run} />
          ) : recent.data && recent.data.length === 0 ? (
            <p class="muted">Records you open in Salesforce will show up here.</p>
          ) : (
            <ul class="result-list">
              {recent.data?.filter((r) => notDeleted(r.id)).map((r) => <ResultRow key={r.id} id={r.id} title={r.name} objectApiName={r.objectApiName} />)}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

export function RecordSearch() {
  return (
    <ConnectionGate>
      <Search />
    </ConnectionGate>
  );
}
