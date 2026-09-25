/**
 * Users: a searchable, filterable, paginated list of the users the connected
 * user may see (Salesforce applies user sharing), and a detail view with their
 * ASSIGNED access. Effective access is never claimed here; specific
 * object/field/record questions go to the access explainer.
 */
import { Fragment } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useWorkspace } from '../../state/workspace';
import { ConnectionGate } from '../../components/ConnectionGate';
import { SearchInput } from '../../components/SearchInput';
import { Alert, EmptyState, ErrorAlert, Loading } from '../../components/States';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { useAsync } from '../../hooks/useAsync';
import {
  DEFAULT_USER_FILTERS,
  MAX_OFFSET,
  USER_PAGE_SIZE,
  USER_TYPE_LABELS,
  listProfiles,
  listUsers,
  loadUserDetail,
  type Part,
  type UserFilters,
} from '../../../shared/salesforce/users';
import { permissionSetGroupUrl, permissionSetUrl, profileUrl, roleUrl, userDetailUrl } from '../../../shared/salesforce/links';
import { formatFieldValue } from '../../../shared/salesforce/records';

const fmtDate = (v?: string | null) => (v ? formatFieldValue(v, 'datetime') : 'Never');
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || '?';

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface ListState {
  filters: UserFilters;
  search: string;
  page: number;
}

/** List state lives in the parent so opening a user and coming Back keeps filters, search, and page. */
function UserList({ state, setState }: { state: ListState; setState: (fn: (s: ListState) => ListState) => void }) {
  const ws = useWorkspace();
  const { filters, search, page } = state;
  const setFilters = (fn: (f: UserFilters) => UserFilters) => setState((s) => ({ ...s, filters: fn(s.filters), page: 0 }));
  const setSearch = (v: string) => setState((s) => ({ ...s, search: v }));
  const setPage = (fn: (p: number) => number) => setState((s) => ({ ...s, page: fn(s.page) }));
  const debounced = useDebounced(search);
  const effective = useMemo(() => ({ ...filters, search: debounced }), [filters, debounced]);
  const [lastSearch, setLastSearch] = useState(debounced);
  useEffect(() => {
    if (debounced !== lastSearch) {
      setLastSearch(debounced);
      setState((s) => ({ ...s, page: 0 }));
    }
  }, [debounced]);

  const profiles = useAsync(ws.client ? (signal) => listProfiles(ws.client!, signal) : null, [ws.client]);
  const userTypes = useAsync(
    ws.metadata ? async (signal) => (await ws.metadata!.describe('User', { signal })).value.fields.find((f) => f.name === 'UserType')?.picklistValues.filter((p) => p.active) ?? [] : null,
    [ws.metadata],
  );
  const list = useAsync(ws.client ? (signal) => listUsers(ws.client!, effective, page, signal) : null, [ws.client, effective, page]);

  const set = (patch: Partial<UserFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const filtered = search || filters.active !== DEFAULT_USER_FILTERS.active || filters.profileId || filters.userType || filters.sort !== DEFAULT_USER_FILTERS.sort;
  const total = list.data?.total ?? 0;
  const from = list.data ? list.data.offset + 1 : 0;
  const to = list.data ? list.data.offset + list.data.rows.length : 0;
  const lastPage = Math.max(0, Math.ceil(Math.min(total, MAX_OFFSET + USER_PAGE_SIZE) / USER_PAGE_SIZE) - 1);
  const typeOptions = userTypes.data?.length ? userTypes.data.map((p) => [p.value, USER_TYPE_LABELS[p.value] ?? p.label] as const) : Object.entries(USER_TYPE_LABELS);

  return (
    <>
      <section class="card stack users-filter-card" aria-label="Find users">
        <div class="card-title users-filter-header">
          <div><span class="section-kicker">Directory</span><h2>Find users</h2></div>
          {filtered && <button class="btn small ghost" onClick={() => setState(() => ({ filters: DEFAULT_USER_FILTERS, search: '', page: 0 }))}>Clear all</button>}
        </div>
        <div class="filter-bar users-filters">
          <SearchInput placeholder="Search name, username, or email" label="Search users" value={search} onValue={setSearch} />
          <select aria-label="Status" value={filters.active} onChange={(e) => set({ active: e.currentTarget.value as UserFilters['active'] })}>
            <option value="active">Active users</option>
            <option value="inactive">Inactive users</option>
            <option value="all">All users</option>
          </select>
          <select aria-label="Profile" value={filters.profileId} disabled={!!profiles.error} title={profiles.error ? "Profiles aren't visible to your user" : undefined} onChange={(e) => set({ profileId: e.currentTarget.value })}>
            <option value="">{profiles.error ? 'Profiles unavailable' : 'Any profile'}</option>
            {profiles.data?.map((p) => (
              <option key={p.Id} value={p.Id}>
                {p.Name}
              </option>
            ))}
          </select>
          <select aria-label="User type" value={filters.userType} onChange={(e) => set({ userType: e.currentTarget.value })}>
            <option value="">Any user type</option>
            {typeOptions.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select aria-label="Sort" value={filters.sort} onChange={(e) => set({ sort: e.currentTarget.value as UserFilters['sort'] })}>
            <option value="name">Sort by name</option>
            <option value="lastLogin">Recent login first</option>
            <option value="created">Newest first</option>
          </select>
        </div>
      </section>

      <section class="card stack" aria-labelledby="users-h" aria-busy={list.loading}>
        <div class="card-title">
          <h2 id="users-h">{list.data ? (total ? `${total.toLocaleString()} user${total === 1 ? '' : 's'}` : 'No users') : 'Users'}</h2>
          {list.data && total > 0 && (
            <span class="subtle">
              Showing {from.toLocaleString()}–{to.toLocaleString()}
            </span>
          )}
        </div>
        {list.loading && !list.data ? (
          <Loading label="Loading users…" />
        ) : list.error ? (
          <ErrorAlert error={list.error} onRetry={list.run} />
        ) : list.data && list.data.rows.length === 0 ? (
          <EmptyState title="No users match" icon="search">
            <p>Try another search or clear the filters. You only see users that Salesforce shares with you.</p>
          </EmptyState>
        ) : (
          <ul class="user-grid">
            {list.data?.rows.map((u) => (
              <li key={u.Id}>
                <button class="user-card" onClick={() => ws.navigate({ tool: 'users', params: { userId: u.Id } })}>
                  <span class="user-avatar" aria-hidden="true">{initials(u.Name)}</span>
                  <span class="user-card-body">
                    <span class="user-card-heading"><strong class="ellipsis">{u.Name}</strong><span class={`pill ${u.IsActive ? 'ok' : ''}`}>{u.IsActive ? 'Active' : 'Inactive'}</span></span>
                    <span class="user-identity ellipsis">{u.Username}</span>
                    {u.Email && u.Email !== u.Username && <span class="user-identity ellipsis">{u.Email}</span>}
                    <span class="user-card-meta"><span>{u.Profile?.Name ?? 'No profile visible'}</span><span>{USER_TYPE_LABELS[u.UserType] ?? u.UserType}</span></span>
                    <span class="user-last-login">Last login <strong>{fmtDate(u.LastLoginDate)}</strong></span>
                  </span>
                  <Icon name="chevron" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {list.data && total > USER_PAGE_SIZE && (
          <nav class="pager" aria-label="Pages">
            <button class="btn small" disabled={page === 0 || list.loading} onClick={() => setPage((p) => p - 1)}>
              <Icon name="back" /> Previous
            </button>
            <span class="subtle" aria-live="polite">
              Page {page + 1} of {lastPage + 1}
            </span>
            <button class="btn small" disabled={page >= lastPage || list.loading} onClick={() => setPage((p) => p + 1)}>
              Next <Icon name="chevron" />
            </button>
          </nav>
        )}
        {list.data && total > MAX_OFFSET + USER_PAGE_SIZE && <p class="subtle">Salesforce lets apps page through the first {MAX_OFFSET.toLocaleString()} results. Narrow the filters to reach the rest.</p>}
      </section>
    </>
  );
}

function PartBlock<T>({ part: p, children, empty }: { part: Part<T>; children: (v: T) => preact.ComponentChildren; empty?: (v: T) => boolean }) {
  if (!p.ok) return <Alert kind="warning" title="Not available to your user">{p.error}</Alert>;
  if (empty?.(p.value)) return <p class="muted">None.</p>;
  return <>{children(p.value)}</>;
}

function UserDetailView({ userId }: { userId: string }) {
  const ws = useWorkspace();
  const detail = useAsync(ws.client ? (signal) => loadUserDetail(ws.client!, userId, signal) : null, [ws.client, userId]);
  if (detail.loading && !detail.data) return <Loading label="Loading user…" />;
  if (detail.error) return <ErrorAlert error={detail.error} onRetry={detail.run} />;
  const data = detail.data;
  if (!data) return null;
  const u = data.user;
  if (!u) {
    return (
      <EmptyState title="User not found" icon="search">
        <p>The user may not exist, or Salesforce doesn't share them with you.</p>
      </EmptyState>
    );
  }
  const org = ws.org!;
  const kv: Array<[string, preact.ComponentChildren]> = [
    ['Email', u.Email ? <a href={`mailto:${u.Email}`}>{u.Email}</a> : '—'],
    ['Title', u.Title || '—'],
    ['Department', u.Department || '—'],
    ['Company', u.CompanyName || '—'],
    ['Phone', u.Phone || u.MobilePhone || '—'],
    ['Manager', u.ManagerId ? <button class="link-button" onClick={() => ws.navigate({ tool: 'users', params: { userId: u.ManagerId! } })}>{u.Manager?.Name ?? u.ManagerId}</button> : '—'],
    ['Role', u.UserRoleId ? <a href={roleUrl(org, u.UserRoleId)} target="_blank" rel="noopener noreferrer">{u.UserRole?.Name ?? u.UserRoleId}</a> : 'No role'],
    ['User license', u.Profile?.UserLicense?.Name ?? '—'],
    ['User type', USER_TYPE_LABELS[u.UserType] ?? u.UserType],
    ['Federation ID', u.FederationIdentifier || '—'],
    ['Time zone', u.TimeZoneSidKey ?? '—'],
    ['Locale / language', [u.LocaleSidKey, u.LanguageLocaleKey].filter(Boolean).join(' · ') || '—'],
    ['Last login', fmtDate(u.LastLoginDate)],
    ['Created', fmtDate(u.CreatedDate)],
  ];
  return (
    <>
      <section class="card stack user-detail-hero" aria-labelledby="user-h">
        <div class="record-head user-detail-head">
          <span class="user-avatar large" aria-hidden="true">{initials(u.Name)}</span>
          <div class="grow user-detail-title">
            <div class="section-kicker">User profile</div>
            <h2 id="user-h">
              {u.Name} <span class={`pill ${u.IsActive ? 'ok' : ''}`}>{u.IsActive ? 'Active' : 'Inactive'}</span>
            </h2>
            <div class="row nowrap subtle">
              <span class="break">{u.Username}</span>
              <CopyButton value={u.Username} label="Copy username" />
            </div>
          </div>
        </div>
        <dl class="highlights">
          <div>
            <dt>Profile</dt>
            <dd>{u.ProfileId ? <a href={profileUrl(org, u.ProfileId)} target="_blank" rel="noopener noreferrer">{u.Profile?.Name ?? u.ProfileId}</a> : '—'}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{u.UserRole?.Name ?? 'No role'}</dd>
          </div>
          <div>
            <dt>User type</dt>
            <dd>{USER_TYPE_LABELS[u.UserType] ?? u.UserType}</dd>
          </div>
          <div>
            <dt>Last login</dt>
            <dd>{fmtDate(u.LastLoginDate)}</dd>
          </div>
        </dl>
        <div class="record-actions">
          <button class="btn primary" onClick={() => ws.navigate({ tool: 'access', params: { userId: u.Id } })}>
            <Icon name="shield" /> Check this user's access
          </button>
          <a class="btn" href={userDetailUrl(org, u.Id)} target="_blank" rel="noopener noreferrer">
            <Icon name="external" /> Open in Salesforce
          </a>
        </div>
      </section>

      <div class="user-detail-grid">
        <section class="card stack user-detail-card user-identity-card" aria-labelledby="user-details-h">
          <div><span class="section-kicker">Identity</span><h2 id="user-details-h">Details</h2></div>
          <dl class="kv">
            {kv.map(([k, v]) => (
              <Fragment key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </Fragment>
            ))}
          </dl>
        </section>

        <section class="card stack user-detail-card user-assigned-card" aria-labelledby="assigned-h">
          <div><span class="section-kicker">Permissions</span><h2 id="assigned-h">Assigned access</h2></div>
          <div class="alert info">
            <strong>Assigned, not effective</strong>
            This is what's assigned to the user. What they can actually do also depends on sharing, the role hierarchy, record ownership, permission set group muting, and session activation.
          </div>
          <PartBlock part={data.assigned}>
            {(sets) => {
              const profile = sets.find((s) => s.kind === 'profile');
              const groups = sets.filter((s) => s.kind === 'group');
              const ps = sets.filter((s) => s.kind === 'permissionSet');
              return (
                <div class="assigned-groups">
                  <div class="assigned-block profile-block">
                    <span class="section-label">Profile</span>
                    <p style={{ margin: 0 }}>{profile ? <a href={u.ProfileId ? profileUrl(org, u.ProfileId) : '#'} target="_blank" rel="noopener noreferrer">{profile.label}</a> : (u.Profile?.Name ?? '—')}</p>
                  </div>
                  <div class="assigned-block">
                    <span class="section-label">Permission set groups ({groups.length})</span>
                    {groups.length === 0 ? (
                      <p class="subtle">None.</p>
                    ) : (
                      <ul class="list compact">
                        {groups.map((g) => (
                          <li key={g.permissionSetId}>
                            <span class="grow">
                              <a href={permissionSetGroupUrl(org, g.groupId ?? g.permissionSetId)} target="_blank" rel="noopener noreferrer">
                                {g.label}
                              </a>{' '}
                              <span class="subtle">{g.apiName}</span>
                            </span>
                            {g.expires && <span class="pill warning">Expires {formatFieldValue(g.expires, 'datetime')}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div class="assigned-block permission-block">
                    <span class="section-label">Permission sets ({ps.length})</span>
                    {ps.length === 0 ? (
                      <p class="subtle">None.</p>
                    ) : (
                      <ul class="list compact">
                        {ps.map((p) => (
                          <li key={p.permissionSetId}>
                            <span class="grow">
                              <a href={permissionSetUrl(org, p.permissionSetId)} target="_blank" rel="noopener noreferrer">
                                {p.label}
                              </a>{' '}
                              <span class="subtle">
                                {p.apiName}
                                {p.license ? ` · ${p.license}` : ''}
                              </span>
                            </span>
                            {p.sessionActivation && <span class="pill info">Session activation</span>}
                            {p.expires && <span class="pill warning">Expires {formatFieldValue(p.expires, 'datetime')}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              );
            }}
          </PartBlock>
          <div>
            <span class="section-label">Permission set licenses</span>
            <PartBlock part={data.licenses} empty={(v) => v.length === 0}>
              {(v) => <p style={{ margin: 0 }}>{v.join(', ')}</p>}
            </PartBlock>
          </div>
        </section>

        <section class="card stack user-detail-card user-security-card" aria-labelledby="sysperm-h">
          <div><span class="section-kicker">Security</span><h2 id="sysperm-h">Key system permissions</h2></div>
          <p class="subtle" style={{ margin: 0 }}>
            From the assignments above. A “Yes” means at least one assignment grants it (group muting is already applied by Salesforce); permissions from session-based sets only apply after activation.
          </p>
          <PartBlock part={data.system} empty={(v) => v.length === 0}>
            {(perms) => (
              <ul class="list compact system-permission-list">
                {perms.map((p) => (
                  <li key={p.field}>
                    <span class="grow">
                      <strong>{p.label}</strong>
                      {p.grantedBy.length > 0 && <div class="subtle">{p.grantedBy.join('; ')}</div>}
                    </span>
                    <span class={`pill ${p.grantedBy.length ? 'granted' : ''}`}>{p.grantedBy.length ? 'Yes' : 'No'}</span>
                  </li>
                ))}
              </ul>
            )}
          </PartBlock>
        </section>

        <section class="card stack user-detail-card user-membership-card" aria-labelledby="groups-h">
          <div><span class="section-kicker">Membership</span><h2 id="groups-h">Public groups & queues</h2></div>
          <p class="subtle" style={{ margin: 0 }}>
            Direct memberships only. Membership through roles, territories, or nested groups isn't listed.
          </p>
          <PartBlock part={data.groups} empty={(v) => v.length === 0}>
            {(groups) => (
              <ul class="list compact membership-list">
                {groups.map((g) => (
                  <li key={g.id}>
                    <span class="grow">{g.name}</span>
                    <span class="pill">{g.type === 'Queue' ? 'Queue' : g.type === 'Regular' ? 'Public group' : g.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </PartBlock>
        </section>
      </div>
    </>
  );
}

export function Users() {
  const ws = useWorkspace();
  const userId = ws.route.params?.userId;
  const [listState, setListState] = useState<ListState>({ filters: DEFAULT_USER_FILTERS, search: '', page: 0 });
  return <ConnectionGate>{userId ? <UserDetailView key={userId} userId={userId} /> : <UserList state={listState} setState={setListState} />}</ConnectionGate>;
}
