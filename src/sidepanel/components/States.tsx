/** Empty, loading, error, and disconnected states used across tools. */
import type { ComponentChildren } from 'preact';
import { explainError } from '../../shared/api/errors';
import { Icon } from './Icon';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div class="row" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true" />
      <span class="muted">{label}</span>
    </div>
  );
}

export function EmptyState({ title, children, icon = 'info' }: { title: string; children?: ComponentChildren; icon?: 'info' | 'search' | 'plug' | 'warning' | 'record' | 'trash' | 'code' }) {
  return (
    <div class="state">
      <Icon name={icon} />
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const ex = explainError(error);
  if (ex.kind === 'cancelled') return null;
  return (
    <div class="alert error" role="alert">
      <strong>{ex.title}</strong>
      <div class="break">{ex.detail}</div>
      {ex.action && <div class="subtle" style={{ marginTop: 4 }}>{ex.action}</div>}
      {onRetry && ex.retryable && (
        <button class="btn small" style={{ marginTop: 6 }} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Alert({ kind, title, children }: { kind: 'info' | 'warning' | 'error' | 'success'; title?: string; children?: ComponentChildren }) {
  return (
    <div class={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'note'}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}
