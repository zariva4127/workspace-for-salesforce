/** Save-to-workspace controls: a star toggle and the name/rename modal. */
import { useEffect, useState } from 'preact/hooks';
import { FieldError, Modal } from './Modal';
import { Icon } from './Icon';
import { useFavorites } from '../hooks/useFavorites';
import { validateLabel, type Favorite, type FavoriteKind } from '../../shared/workspace/favorites';

const KIND_LABEL: Record<FavoriteKind, string> = { object: 'object', record: 'record', query: 'query' };

export function FavoriteModal({
  open,
  kind,
  initialLabel,
  editing,
  preview,
  onSave,
  onClose,
}: {
  open: boolean;
  kind: FavoriteKind;
  initialLabel: string;
  editing?: Favorite;
  preview?: string;
  onSave: (label: string) => Promise<void>;
  onClose: () => void;
}) {
  const favs = useFavorites();
  const [label, setLabel] = useState(initialLabel);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setLabel(initialLabel);
      setTouched(false);
    }
  }, [open, initialLabel]);
  const error = validateLabel(favs.list, label, kind, editing?.id);
  return (
    <Modal
      open={open}
      title={editing ? `Rename saved ${KIND_LABEL[kind]}` : `Save ${KIND_LABEL[kind]} to your workspace`}
      description={editing ? undefined : 'Saved items appear on Home for this org.'}
      dirty={label !== initialLabel}
      saveLabel={editing ? 'Save' : 'Save to workspace'}
      onSave={async () => {
        setTouched(true);
        if (error) return false;
        await onSave(label.trim());
      }}
      onClose={onClose}
    >
      <div class="field">
        <label for="fav-name">Name</label>
        <input
          id="fav-name"
          value={label}
          maxLength={80}
          autoFocus
          aria-invalid={touched && !!error}
          aria-describedby={touched && error ? 'fav-name-err' : undefined}
          onInput={(e) => setLabel(e.currentTarget.value)}
          onBlur={() => setTouched(true)}
        />
        <FieldError id="fav-name-err" message={touched ? error : undefined} />
      </div>
      {preview && (
        <details>
          <summary>Details</summary>
          <pre class="log">{preview}</pre>
        </details>
      )}
    </Modal>
  );
}

/** Star button: saves (after naming) or removes the item. */
export function FavoriteButton({ kind, value, defaultLabel, objectApiName }: { kind: FavoriteKind; value: string; defaultLabel: string; objectApiName?: string }) {
  const favs = useFavorites();
  const [open, setOpen] = useState(false);
  if (!favs.available || !value) return null;
  const existing = favs.find(kind, value);
  return (
    <>
      <button
        type="button"
        class={`btn small ${existing ? 'saved' : ''}`}
        aria-pressed={!!existing}
        onClick={() => (existing ? void favs.remove(existing) : setOpen(true))}
        title={existing ? 'Remove from your workspace' : 'Save to your workspace'}
      >
        <Icon name="star" /> {existing ? 'Saved' : 'Save'}
      </button>
      <FavoriteModal
        open={open}
        kind={kind}
        initialLabel={defaultLabel}
        {...(kind === 'query' ? { preview: value } : {})}
        onClose={() => setOpen(false)}
        onSave={(label) => favs.add({ kind, value, label, ...(objectApiName ? { objectApiName } : {}) })}
      />
    </>
  );
}
