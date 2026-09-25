/**
 * Transient success/error messages with an optional action (e.g. Undo).
 * Announced to screen readers through a polite live region.
 */
import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useRef, useState } from 'preact/hooks';
import { Icon } from './Icon';

export interface ToastOptions {
  kind?: 'success' | 'error' | 'info';
  message: string;
  action?: { label: string; onClick: () => void };
  /** Milliseconds before auto-dismiss. Toasts with an action stay longer. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

const Ctx = createContext<(t: ToastOptions) => void>(() => undefined);

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (t: ToastOptions) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-2), { ...t, id }]);
      setTimeout(() => dismiss(id), t.duration ?? (t.action ? 6000 : 3000));
    },
    [dismiss],
  );

  return (
    <Ctx.Provider value={show}>
      {children}
      <div class="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} class={`toast ${t.kind ?? 'success'}`}>
            <Icon name={t.kind === 'error' ? 'warning' : t.kind === 'info' ? 'info' : 'check'} />
            <span class="grow">{t.message}</span>
            {t.action && (
              <button
                class="btn small"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button class="icon-btn" aria-label="Dismiss message" onClick={() => dismiss(t.id)}>
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
