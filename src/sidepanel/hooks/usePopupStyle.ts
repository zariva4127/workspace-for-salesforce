/**
 * Positions a dropdown with `position: fixed` next to its anchor so scrolling
 * containers (like the record form's body) can't clip it. It opens downward,
 * flips above when there's more room there, and is capped to the viewport.
 */
import { useLayoutEffect, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import type { JSX } from 'preact';

const GAP = 4;
const MARGIN = 8;
const PREFERRED_HEIGHT = 320;
const MIN_COMFORTABLE = 200;

export function popupPlacement(anchor: { top: number; bottom: number; left: number; width: number }, viewportHeight: number) {
  const below = viewportHeight - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const up = below < MIN_COMFORTABLE && above > below;
  const maxHeight = Math.max(120, Math.min(PREFERRED_HEIGHT, up ? above : below));
  return { up, maxHeight };
}

export function usePopupStyle(open: boolean, anchor: RefObject<HTMLElement>): JSX.CSSProperties | undefined {
  const [style, setStyle] = useState<JSX.CSSProperties>();
  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }
    const update = () => {
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const { up, maxHeight } = popupPlacement(r, window.innerHeight);
      setStyle({
        position: 'fixed',
        left: `${r.left}px`,
        width: `${r.width}px`,
        right: 'auto',
        maxHeight: `${maxHeight}px`,
        ...(up ? { top: 'auto', bottom: `${window.innerHeight - r.top + GAP}px` } : { top: `${r.bottom + GAP}px`, bottom: 'auto' }),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);
  return style;
}
