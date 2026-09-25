/** The org badge: environment + configurable name and color. Production is always visually emphasized. */
import { ENVIRONMENT_LABELS } from '../../shared/org/identity';
import { badgeColor, displayName, effectiveEnvironment, readableTextColor, type OrgProfile } from '../../shared/org/profiles';

/** Short environment tags keep the org name readable in narrow windows; the full label is in the tooltip. */
const SHORT_ENV: Record<ReturnType<typeof effectiveEnvironment>, string> = {
  production: '⚠ PROD',
  sandbox: 'SANDBOX',
  scratch: 'SCRATCH',
  developer: 'DEV ED',
  trailhead: 'TRAILHEAD',
  demo: 'DEMO',
  unknown: 'ORG',
};

export function OrgBadge({ org, large }: { org: OrgProfile; large?: boolean }) {
  const env = effectiveEnvironment(org);
  const bg = badgeColor(org);
  const fg = readableTextColor(bg);
  const name = displayName(org);
  return (
    <span
      class={`org-badge ${env} ${large ? 'large' : ''}`}
      style={{ background: bg, color: fg }}
      title={`${name} — ${ENVIRONMENT_LABELS[env]}${org.organizationType ? ` · ${org.organizationType}` : ''} (${org.apiHost})`}
      aria-label={`${name}, ${ENVIRONMENT_LABELS[env]}${org.organizationType ? `, ${org.organizationType}` : ''}`}
    >
      <span class="env">{SHORT_ENV[env]}</span>
      <span class="name">{name}</span>
    </span>
  );
}

/** A thin colored strip across the top of the panel, so the environment is visible even when scrolled. */
export function EnvStrip({ org }: { org: OrgProfile | null }) {
  if (!org) return null;
  return <div class="prod-strip" style={{ background: badgeColor(org) }} aria-hidden="true" />;
}
