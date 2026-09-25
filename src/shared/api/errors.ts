/** Typed Salesforce API errors and user-facing explanations. */

export interface SalesforceErrorBody {
  errorCode?: string;
  message?: string;
  fields?: string[];
}

export class SalesforceApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly fields: string[] = [],
    /** Every error Salesforce returned (DML can report several, each tied to fields). */
    readonly errors: SalesforceErrorBody[] = [],
  ) {
    super(message);
    this.name = 'SalesforceApiError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'CancelledError';
  }
}

export class NotConnectedError extends Error {
  constructor(message = 'Not connected to this org.') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof DOMException && e.name === 'AbortError');
}

export async function parseErrorResponse(res: Response): Promise<SalesforceApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const all: SalesforceErrorBody[] = (Array.isArray(body) ? body : body ? [body] : []).filter((e): e is SalesforceErrorBody => !!e && typeof e === 'object');
  const first = all[0];
  // 412: the record changed after the If-Unmodified-Since timestamp we sent.
  const code = res.status === 412 ? 'CONFLICT' : (first?.errorCode ?? `HTTP_${res.status}`);
  const message = res.status === 412 ? 'This record was changed by someone else after you opened it.' : (first?.message ?? (res.statusText || `HTTP ${res.status}`));
  return new SalesforceApiError(res.status, code, message, first?.fields ?? [], all);
}

export type ErrorKind = 'auth' | 'permission' | 'limit' | 'notFound' | 'query' | 'server' | 'network' | 'cancelled' | 'conflict' | 'validation' | 'unknown';

export interface ExplainedError {
  kind: ErrorKind;
  title: string;
  detail: string;
  /** Suggested next step for the user. */
  action?: string;
  retryable: boolean;
}

/** DML errors caused by the submitted values; the user can fix them and try again. */
const VALIDATION_CODES = new Set([
  'FIELD_CUSTOM_VALIDATION_EXCEPTION',
  'REQUIRED_FIELD_MISSING',
  'STRING_TOO_LONG',
  'INVALID_EMAIL_ADDRESS',
  'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
  'INVALID_CROSS_REFERENCE_KEY',
  'FIELD_INTEGRITY_EXCEPTION',
  'DUPLICATE_VALUE',
  'DUPLICATES_DETECTED',
  'NUMBER_OUTSIDE_VALID_RANGE',
  'INVALID_TYPE_ON_FIELD_IN_RECORD',
  'JSON_PARSER_ERROR',
  'MALFORMED_ID',
  'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
  'DELETE_FAILED',
  'INVALID_FIELD_FOR_INSERT_UPDATE',
]);

/** Maps any thrown value to a message suitable for the UI. */
export function explainError(e: unknown): ExplainedError {
  if (isCancelled(e)) return { kind: 'cancelled', title: 'Cancelled', detail: 'The request was cancelled.', retryable: true };
  if (e instanceof NotConnectedError) {
    return { kind: 'auth', title: 'Not connected', detail: e.message, action: 'Connect this org to continue.', retryable: false };
  }
  if (e instanceof NetworkError) {
    return {
      kind: 'network',
      title: 'Network problem',
      detail: e.message,
      action: 'Check your connection or VPN, then retry.',
      retryable: true,
    };
  }
  if (e instanceof SalesforceApiError) {
    const d = e.message;
    switch (e.errorCode) {
      case 'INVALID_SESSION_ID':
        return { kind: 'auth', title: 'Session expired', detail: d, action: 'Reconnect this org.', retryable: false };
      case 'API_DISABLED_FOR_ORG':
      case 'API_CURRENTLY_DISABLED':
        return {
          kind: 'permission',
          title: 'API access is not available',
          detail: d,
          action: 'The org edition or your user lacks the "API Enabled" permission. Ask an admin.',
          retryable: false,
        };
      case 'INSUFFICIENT_ACCESS':
      case 'INSUFFICIENT_ACCESS_OR_READONLY':
      case 'INSUFFICIENT_PRIVILEGES':
        return {
          kind: 'permission',
          title: 'Insufficient permissions',
          detail: d,
          action: 'Your Salesforce user cannot access this. The result is limited by your own permissions.',
          retryable: false,
        };
      case 'REQUEST_LIMIT_EXCEEDED':
        return {
          kind: 'limit',
          title: 'API limit reached',
          detail: d,
          action: 'The org has hit its API request limit. Wait and try again later.',
          retryable: false,
        };
      case 'CONFLICT':
        return { kind: 'conflict', title: 'Changed by someone else', detail: d, action: 'Reload the latest version, then save again.', retryable: false };
      case 'ENTITY_IS_LOCKED':
        return { kind: 'permission', title: 'Record is locked', detail: d, action: 'An approval process or other lock prevents changes. Ask an admin or the approver.', retryable: false };
      case 'NOT_FOUND':
      case 'ENTITY_IS_DELETED':
        return { kind: 'notFound', title: 'Not found', detail: d, action: 'It may have been deleted or you may lack access.', retryable: false };
      case 'MALFORMED_QUERY':
      case 'INVALID_FIELD':
      case 'INVALID_TYPE':
      case 'INVALID_QUERY_FILTER_OPERATOR':
      case 'QUERY_TIMEOUT':
        return { kind: 'query', title: 'Query problem', detail: d, retryable: false };
    }
    if (VALIDATION_CODES.has(e.errorCode)) {
      return { kind: 'validation', title: "Salesforce didn't save the record", detail: d, retryable: false };
    }
    if (e.status === 401) return { kind: 'auth', title: 'Session expired', detail: d, action: 'Reconnect this org.', retryable: false };
    if (e.status === 403) return { kind: 'permission', title: 'Access denied', detail: d, retryable: false };
    if (e.status === 404) return { kind: 'notFound', title: 'Not found', detail: d, retryable: false };
    if (e.status >= 500) return { kind: 'server', title: 'Salesforce server error', detail: d, action: 'Retry in a moment.', retryable: true };
    return { kind: 'unknown', title: e.errorCode, detail: d, retryable: false };
  }
  const detail = e instanceof Error ? e.message : String(e);
  return { kind: 'unknown', title: 'Something went wrong', detail, retryable: true };
}
