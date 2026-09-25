/**
 * The one search box used across the workspace: search icon on the right, and a
 * clear button (×) once there's text. Escape also clears.
 */
import type { JSX, Ref } from 'preact';
import { Icon } from './Icon';

type InputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onInput' | 'ref' | 'type'>;

export function SearchInput({
  value,
  onValue,
  label,
  inputRef,
  class: cls,
  style,
  ...rest
}: InputProps & { value: string; onValue: (v: string) => void; label: string; inputRef?: Ref<HTMLInputElement>; class?: string }) {
  return (
    <div class={`search-field ${cls ?? ''}`} style={style}>
      <input
        {...rest}
        ref={inputRef}
        type="search"
        aria-label={rest.id ? undefined : label}
        value={value}
        onInput={(e) => onValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onValue('');
          }
          (rest.onKeyDown as ((e: KeyboardEvent) => void) | undefined)?.(e as unknown as KeyboardEvent);
        }}
      />
      {value && (
        <button type="button" class="field-clear" aria-label={`Clear ${label.toLowerCase()}`} title="Clear" onClick={() => onValue('')}>
          <Icon name="close" />
        </button>
      )}
      <Icon name="search" class="field-icon" />
    </div>
  );
}
