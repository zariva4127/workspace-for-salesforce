/** Small inline SVG icon set (no icon fonts or remote assets). Decorative by default. */
import type { IconName } from '../state/routes';

type Name = IconName | 'search' | 'copy' | 'check' | 'external' | 'refresh' | 'close' | 'plug' | 'warning' | 'camera' | 'download' | 'trash' | 'plus' | 'info' | 'stop' | 'star' | 'back' | 'chevron' | 'edit' | 'link';

const PATHS: Record<Name, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  record: 'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h8',
  transfer: 'M4 7h13M13 3l4 4-4 4M20 17H7M11 13l-4 4 4 4',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6zM9 12l2 2 4-4',
  flow: 'M4 4h6v5H4zM14 15h6v5h-6zM7 9v4a2 2 0 0 0 2 2h5M17 15v-4',
  code: 'M8 7 3 12l5 5M16 7l5 5-5 5M14 4l-4 16',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13a7.9 7.9 0 0 0 0-2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-1.7-1L15 3.5h-4L10.7 6a8 8 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.9 7.9 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.3 2.5h4l.3-2.5a8 8 0 0 0 1.7-1l2.4 1 2-3.4z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M4 12l5 5L20 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
  close: 'M6 6l12 12M18 6 6 18',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  warning: 'M12 3 2 20h20zM12 10v4M12 17v.5',
  camera: 'M4 7h4l2-3h4l2 3h4v13H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  plus: 'M12 5v14M5 12h14',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7v.5',
  stop: 'M6 6h12v12H6z',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z',
  back: 'M15 18l-6-6 6-6',
  chevron: 'M9 6l6 6-6 6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
};

export function Icon({ name, label, class: cls }: { name: Name; label?: string; class?: string }) {
  return (
    <svg
      class={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}
      width="16"
      height="16"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
