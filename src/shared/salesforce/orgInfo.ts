/** Loads org, user, and API availability details for the Overview. */
import { soqlString, type SalesforceClient } from '../api/client';
import { explainError } from '../api/errors';

export interface OrgInfo {
  organization?: {
    Id: string;
    Name: string;
    IsSandbox: boolean;
    OrganizationType: string;
    InstanceName: string;
    TrialExpirationDate: string | null;
    NamespacePrefix: string | null;
  };
  user?: {
    Id: string;
    Name: string;
    Username: string;
    Email: string;
    Profile?: { Name: string } | null;
    UserRole?: { Name: string } | null;
    TimeZoneSidKey: string;
    LanguageLocaleKey: string;
  };
  latestApiVersion?: string;
  apiRequests?: { max: number; remaining: number };
  errors: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadOrgInfo(client: SalesforceClient, userId: string, signal?: AbortSignal): Promise<OrgInfo> {
  const errors: string[] = [];
  const opt = signal ? { signal } : {};
  const safe = async <T>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      const ex = explainError(e);
      if (ex.kind === 'cancelled') throw e;
      errors.push(`${label}: ${ex.title} — ${ex.detail}`);
      return undefined;
    }
  };

  const [versions, org, user, limits] = await Promise.all([
    safe('API versions', () => client.versions(signal)),
    safe('Organization', async () =>
      (
        await client.query<any>(
          'SELECT Id, Name, IsSandbox, OrganizationType, InstanceName, TrialExpirationDate, NamespacePrefix FROM Organization LIMIT 1',
          opt,
        )
      ).records[0],
    ),
    safe('User', async () =>
      (
        await client.query<any>(
          `SELECT Id, Name, Username, Email, Profile.Name, UserRole.Name, TimeZoneSidKey, LanguageLocaleKey FROM User WHERE Id = ${soqlString(userId)}`,
          opt,
        )
      ).records[0],
    ),
    safe('Limits', () => client.limits(signal)),
  ]);

  const latest = versions?.map((v) => v.version).sort((a, b) => Number(b) - Number(a))[0];
  const daily = limits?.DailyApiRequests;
  return {
    ...(org ? { organization: org } : {}),
    ...(user ? { user } : {}),
    ...(latest ? { latestApiVersion: latest } : {}),
    ...(daily ? { apiRequests: { max: daily.Max, remaining: daily.Remaining } } : {}),
    errors,
  };
}
