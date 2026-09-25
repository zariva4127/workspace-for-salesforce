/** Renders one field value by type: links for email/phone/URL/lookups, pills for multi-select, address lines, long text with "Show more". */
import { useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { Icon } from '../../components/Icon';
import { addressLines, displayText, htmlToText, picklistLabels, safeHref, type DisplayContext } from '../../../shared/records/fieldDisplay';
import type { FieldInfo } from '../../../shared/salesforce/metadata';
import type { ParentLookup } from '../../../shared/salesforce/records';
import { recordUrl } from '../../../shared/salesforce/links';

const LONG = 280;

export function FieldValue({ field: f, value, lookup, ctx }: { field: FieldInfo; value: unknown; lookup?: ParentLookup; ctx: DisplayContext }) {
  const ws = useWorkspace();
  const [expanded, setExpanded] = useState(false);

  if (value === null || value === undefined || value === '') {
    return (
      <span class="empty-value">
        <span aria-hidden="true">—</span>
        <span class="visually-hidden">Empty</span>
      </span>
    );
  }
  const text = displayText(f, value, ctx);

  switch (f.type) {
    case 'boolean':
      return (
        <span class={`bool ${value ? 'yes' : 'no'}`}>
          <Icon name={value ? 'check' : 'close'} /> {value ? 'Yes' : 'No'}
        </span>
      );
    case 'reference': {
      const id = String(value);
      return (
        <span class="row ref-value">
          <button type="button" class="link-button" onClick={() => ws.navigate({ tool: 'record', params: { recordId: id } })} title={`Open ${lookup?.name ?? id} in Record details`}>
            {lookup?.name ?? id}
          </button>
          {lookup?.objectApiName && <span class="subtle">{lookup.objectApiName}</span>}
          {ws.org && (
            <a class="icon-btn" href={recordUrl(ws.org, lookup?.objectApiName, id)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${lookup?.name ?? id} in Salesforce`} title="Open in Salesforce">
              <Icon name="external" />
            </a>
          )}
        </span>
      );
    }
    case 'email':
      return <a href={`mailto:${String(value)}`}>{String(value)}</a>;
    case 'phone':
      return <a href={`tel:${String(value).replace(/[^\d+]/g, '')}`}>{String(value)}</a>;
    case 'url': {
      const href = safeHref(String(value));
      return href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" class="break">
          {String(value)} <Icon name="external" class="inline-icon" />
        </a>
      ) : (
        <span class="break">{String(value)}</span>
      );
    }
    case 'address': {
      const lines = addressLines(value);
      return (
        <address class="addr">
          {lines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </address>
      );
    }
    case 'multipicklist':
      return (
        <span class="row">
          {picklistLabels(f, String(value)).map((l) => (
            <span key={l} class="pill">
              {l}
            </span>
          ))}
        </span>
      );
  }

  if (f.type === 'textarea' || text.length > LONG) {
    const full = f.htmlFormatted ? htmlToText(String(value)) : text;
    const long = full.length > LONG;
    return (
      <span class="long-text">
        <span style={{ whiteSpace: 'pre-wrap' }}>{long && !expanded ? `${full.slice(0, LONG).trimEnd()}…` : full}</span>
        {long && (
          <button type="button" class="link-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        {f.htmlFormatted && <span class="subtle"> (formatting removed)</span>}
      </span>
    );
  }
  return <span class="break">{text}</span>;
}
