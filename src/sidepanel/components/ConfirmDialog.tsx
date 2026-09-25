/**
 * Accessible confirmation dialog built on <dialog> (focus trapping and Escape
 * handling come from the browser). Used for destructive local actions and any
 * future operation that changes Salesforce data or metadata.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

export interface ConfirmOptions {
  title: string;
  body: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  /** Require typing this text before confirming (for high-risk actions). */
  typeToConfirm?: string;
}

export function ConfirmDialog({ open, options, onClose }: { open: boolean; options: ConfirmOptions; onClose: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTyped('');
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const canConfirm = !options.typeToConfirm || typed === options.typeToConfirm;
  return (
    <dialog ref={ref} aria-labelledby="confirm-title" onCancel={() => onClose(false)}>
      <div class="stack">
        <h2 id="confirm-title">{options.title}</h2>
        <div>{options.body}</div>
        {options.typeToConfirm && (
          <div class="field">
            <label for="confirm-type">
              Type <code>{options.typeToConfirm}</code> to confirm
            </label>
            <input id="confirm-type" value={typed} onInput={(e) => setTyped(e.currentTarget.value)} autoComplete="off" />
          </div>
        )}
        <div class="row" style={{ justifyContent: 'flex-end' }}>
          <button class="btn" onClick={() => onClose(false)} autoFocus>
            Cancel
          </button>
          <button class={`btn ${options.danger ? 'danger solid' : 'primary'}`} disabled={!canConfirm} onClick={() => onClose(true)}>
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Hook returning a `confirm(options)` promise plus the dialog element to render. */
export function useConfirm(): [(o: ConfirmOptions) => Promise<boolean>, ComponentChildren] {
  const [state, setState] = useState<{ options: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const confirm = (options: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ options, resolve }));
  const el = state ? (
    <ConfirmDialog
      open
      options={state.options}
      onClose={(ok) => {
        state.resolve(ok);
        setState(null);
      }}
    />
  ) : null;
  return [confirm, el];
}
