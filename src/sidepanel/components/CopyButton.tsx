import { useState } from 'preact/hooks';
import { Icon } from './Icon';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Icon button that copies `value` and announces the result to screen readers. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      type="button"
      class="icon-btn"
      title={state === 'ok' ? 'Copied' : label}
      aria-label={state === 'ok' ? `Copied ${label}` : label}
      onClick={async () => {
        setState((await copyText(value)) ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 1500);
      }}
    >
      <Icon name={state === 'ok' ? 'check' : 'copy'} />
      <span class="visually-hidden" aria-live="polite">
        {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : ''}
      </span>
    </button>
  );
}
