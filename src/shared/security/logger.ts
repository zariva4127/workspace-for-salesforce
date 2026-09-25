/**
 * The only sanctioned logger. Every message is passed through `redact` so tokens
 * never reach the console, even when an error object embeds a request or header.
 */
import { redact } from './redact';

function fmt(args: unknown[]): string[] {
  return args.map((a) => {
    if (a instanceof Error) return redact(`${a.name}: ${a.message}`);
    if (typeof a === 'string') return redact(a);
    try {
      return redact(JSON.stringify(a));
    } catch {
      return '[unserializable]';
    }
  });
}

export const log = {
  warn: (...args: unknown[]) => console.warn('[SF Workspace]', ...fmt(args)),
  error: (...args: unknown[]) => console.error('[SF Workspace]', ...fmt(args)),
};
