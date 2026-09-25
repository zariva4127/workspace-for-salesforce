/**
 * "New <object>" button. Loads the object's describe, checks create permission,
 * and opens the record form (optionally prefilled, e.g. with the parent lookup).
 * After saving it shows a toast and, unless told otherwise, opens the new record.
 */
import { useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { useToast } from '../../components/Toasts';
import { Icon } from '../../components/Icon';
import { RecordForm } from './RecordForm';
import type { DraftValue } from '../../../shared/records/recordEdit';
import type { ObjectDescribe } from '../../../shared/salesforce/metadata';
import { explainError } from '../../../shared/api/errors';

export function NewRecordButton({
  objectApiName,
  objectLabel,
  createable,
  prefill,
  prefillNames,
  openAfterCreate = true,
  small,
  primary,
  label,
}: {
  objectApiName: string;
  objectLabel?: string;
  /** From describeGlobal/describe when known; undefined = check on click. */
  createable?: boolean;
  prefill?: Record<string, DraftValue>;
  prefillNames?: Record<string, string>;
  openAfterCreate?: boolean;
  small?: boolean;
  primary?: boolean;
  label?: string;
}) {
  const ws = useWorkspace();
  const toast = useToast();
  const [describe, setDescribe] = useState<ObjectDescribe | null>(null);
  const [busy, setBusy] = useState(false);

  const name = objectLabel ?? objectApiName;
  const disabledReason = !ws.settings.allowRecordChanges
    ? 'Record changes are turned off in Settings.'
    : createable === false
      ? `Your profile or permission sets don't allow creating ${name} records.`
      : undefined;

  const open = async () => {
    if (!ws.metadata) return;
    setBusy(true);
    try {
      const d = (await ws.metadata.describe(objectApiName)).value;
      if (!d.createable) {
        toast({ kind: 'error', message: `You can't create ${d.label} records. Your profile or permission sets don't allow it.` });
        return;
      }
      const blocked = Object.keys(prefill ?? {}).filter((k) => !d.fields.find((f) => f.name === k)?.createable);
      if (blocked.length) toast({ kind: 'info', message: `You can't set ${blocked.join(', ')} yourself, so it isn't prefilled.` });
      setDescribe(d);
    } catch (e) {
      toast({ kind: 'error', message: `Couldn't open the form: ${explainError(e).detail}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        class={`btn ${small ? 'small' : ''} ${primary ? 'primary' : ''}`}
        onClick={() => void open()}
        disabled={!!disabledReason || busy || !ws.metadata}
        title={disabledReason ?? `Create a ${name} record`}
        aria-label={label ? undefined : `New ${name}`}
      >
        <Icon name="plus" /> {busy ? 'Opening…' : (label ?? `New ${name}`)}
      </button>
      {describe && (
        <RecordForm
          mode="create"
          describe={describe}
          {...(prefill ? { prefill } : {})}
          {...(prefillNames ? { lookupNames: prefillNames } : {})}
          onClose={() => setDescribe(null)}
          onSaved={({ id, name: recordName }) => {
            ws.notifyRecordChange({ type: 'created', id, objectApiName: describe.name });
            toast({
              message: `Created ${describe.label} “${recordName}”.`,
              ...(openAfterCreate ? {} : { action: { label: 'Open', onClick: () => ws.navigate({ tool: 'record', params: { recordId: id } }) } }),
            });
            if (openAfterCreate) ws.navigate({ tool: 'record', params: { recordId: id } });
          }}
        />
      )}
    </>
  );
}
