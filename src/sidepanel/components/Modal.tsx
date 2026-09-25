/**
 * Accessible modal for New/Edit flows, built on <dialog> (focus trap, Escape,
 * inert background come from the browser).
 *
 * - The body is a <form>: Enter submits, Save runs `onSave`.
 * - When `dirty` is true, Cancel/Escape/backdrop ask before discarding changes.
 * - `error` shows a form-level message; field errors are rendered by callers
 *   with `FieldError` and linked via aria-describedby.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

export interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  children: ComponentChildren;
  saveLabel?: string;
  /** Return false (or throw) to keep the modal open. */
  onSave: () => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  dirty?: boolean;
  saveDisabled?: boolean;
  error?: string;
  danger?: boolean;
  /** Wider layout for forms with many fields. */
  wide?: boolean;
  /** Extra content in the footer, left of Cancel/Save (e.g. a status). */
  footerNote?: ComponentChildren;
}

export function Modal({ open, title, description, children, saveLabel = 'Save', onSave, onClose, dirty, saveDisabled, error, danger, wide, footerNote }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setConfirmDiscard(false);
      setSaveError(undefined);
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirmDiscard) setConfirmDiscard(true);
    else onClose();
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (saveDisabled || saving) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await onSave();
      if (result !== false) onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    // Backdrop clicks mirror the Escape key, which <dialog> already handles via onCancel.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={ref}
      class={`modal ${wide ? 'wide' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        // Clicking the backdrop (the dialog element itself) behaves like Cancel.
        if (e.target === ref.current) requestClose();
      }}
    >
      <form class="modal-body" onSubmit={submit} noValidate>
        <header class="modal-header">
          <h2 id={titleId}>{title}</h2>
          {description && (
            <p id={descId} class="muted">
              {description}
            </p>
          )}
        </header>
        <div class="modal-content stack">{children}</div>
        {(error || saveError) && (
          <div class="alert error" role="alert">
            {error ?? saveError}
          </div>
        )}
        {confirmDiscard ? (
          <footer class="modal-footer discard" role="alertdialog" aria-label="Discard changes?">
            <span class="grow">Discard your unsaved changes?</span>
            <button type="button" class="btn" onClick={() => setConfirmDiscard(false)} autoFocus>
              Keep editing
            </button>
            <button type="button" class="btn danger" onClick={onClose}>
              Discard
            </button>
          </footer>
        ) : (
          <footer class="modal-footer">
            {footerNote && <span class="grow subtle">{footerNote}</span>}
            <button type="button" class="btn" onClick={requestClose}>
              Cancel
            </button>
            <button type="submit" class={`btn ${danger ? 'danger' : 'primary'}`} disabled={saveDisabled || saving}>
              {saving ? 'Saving…' : saveLabel}
            </button>
          </footer>
        )}
      </form>
    </dialog>
  );
}

export function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  if (!message) return null;
  return (
    <span id={id} class="field-error" role="alert">
      {message}
    </span>
  );
}
