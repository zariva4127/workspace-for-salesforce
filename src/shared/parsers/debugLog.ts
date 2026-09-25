/**
 * Parses Apex debug logs into events, a summary of errors, SOQL/DML activity,
 * and governor limit usage.
 *
 * Log lines look like: `12:34:56.789 (123456789)|EVENT_TYPE|[line]|details...`.
 * Lines that don't start with a timestamp continue the previous event.
 */

export interface LogEvent {
  index: number;
  time: string;
  /** Nanoseconds since the start of the transaction, when present. */
  nanos?: number;
  type: string;
  line?: number;
  detail: string;
}

export interface LimitUsage {
  namespace: string;
  name: string;
  used: number;
  max: number;
}

export interface DebugLogSummary {
  apiVersion?: string;
  logLevels?: string;
  events: LogEvent[];
  countsByType: Record<string, number>;
  errors: LogEvent[];
  debugStatements: LogEvent[];
  soql: Array<{ query: string; rows?: number; line?: number }>;
  dml: Array<{ operation: string; objectType: string; rows: number; line?: number }>;
  limits: LimitUsage[];
  codeUnits: string[];
  flowElements: string[];
  truncated: boolean;
  durationMs?: number;
}

const EVENT_LINE = /^(\d{1,2}:\d{2}:\d{2}\.\d{1,3})\s*(?:\((\d+)\))?\|([A-Z_]+)(?:\|(.*))?$/;
const ERROR_TYPES = new Set(['EXCEPTION_THROWN', 'FATAL_ERROR', 'FLOW_ELEMENT_ERROR', 'VALIDATION_FAIL', 'FLOW_CREATE_INTERVIEW_ERROR', 'DUPLICATE_DETECTION_RULE_INVOCATION_ERROR']);
const LIMIT_LINE = /^\s*(?:Maximum\s+)?([A-Za-z ]+?):\s*(\d+)\s+out of\s+(\d+)/;

export const DEBUG_EVENT_FILTERS: Record<string, string[]> = {
  Errors: [...ERROR_TYPES],
  Debug: ['USER_DEBUG'],
  SOQL: ['SOQL_EXECUTE_BEGIN', 'SOQL_EXECUTE_END'],
  DML: ['DML_BEGIN', 'DML_END'],
  Flow: ['FLOW_START_INTERVIEW_BEGIN', 'FLOW_ELEMENT_BEGIN', 'FLOW_ELEMENT_ERROR', 'FLOW_ELEMENT_FAULT'],
  'Code units': ['CODE_UNIT_STARTED', 'CODE_UNIT_FINISHED'],
  Callouts: ['CALLOUT_REQUEST', 'CALLOUT_RESPONSE'],
};

export function parseDebugLog(body: string): DebugLogSummary {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const events: LogEvent[] = [];
  let apiVersion: string | undefined;
  let logLevels: string | undefined;

  const header = /^(\d+\.\d+)\s+(.*)$/.exec(lines[0] ?? '');
  if (header && !EVENT_LINE.test(lines[0]!)) {
    apiVersion = header[1];
    logLevels = header[2];
  }

  for (const raw of lines) {
    const m = EVENT_LINE.exec(raw);
    if (m) {
      const parts = (m[4] ?? '').split('|');
      const lineMatch = /^\[(\d+)\]$/.exec(parts[0] ?? '');
      const detail = lineMatch ? parts.slice(1).join('|') : parts.join('|');
      events.push({
        index: events.length,
        time: m[1]!,
        ...(m[2] ? { nanos: Number(m[2]) } : {}),
        type: m[3]!,
        ...(lineMatch ? { line: Number(lineMatch[1]) } : {}),
        detail,
      });
    } else if (events.length && raw.length) {
      events[events.length - 1]!.detail += `\n${raw}`;
    }
  }

  const countsByType: Record<string, number> = {};
  for (const e of events) countsByType[e.type] = (countsByType[e.type] ?? 0) + 1;

  const soql: DebugLogSummary['soql'] = [];
  const dml: DebugLogSummary['dml'] = [];
  const limits: LimitUsage[] = [];
  const codeUnits: string[] = [];
  const flowElements: string[] = [];
  let currentNs = '(default)';

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    switch (e.type) {
      case 'SOQL_EXECUTE_BEGIN': {
        const query = e.detail.split('|').pop() ?? e.detail;
        const end = events.slice(i + 1, i + 50).find((x) => x.type === 'SOQL_EXECUTE_END');
        const rows = end ? /Rows:(\d+)/.exec(end.detail)?.[1] : undefined;
        soql.push({ query: query.trim(), ...(rows ? { rows: Number(rows) } : {}), ...(e.line ? { line: e.line } : {}) });
        break;
      }
      case 'DML_BEGIN': {
        const op = /Op:(\w+)/.exec(e.detail)?.[1] ?? '?';
        const type = /Type:([\w]+)/.exec(e.detail)?.[1] ?? '?';
        const rows = Number(/Rows:(\d+)/.exec(e.detail)?.[1] ?? 0);
        dml.push({ operation: op, objectType: type, rows, ...(e.line ? { line: e.line } : {}) });
        break;
      }
      case 'LIMIT_USAGE_FOR_NS': {
        const nsMatch = /^\(?([^)|\n]+)\)?/.exec(e.detail);
        currentNs = nsMatch?.[1]?.trim() || '(default)';
        for (const l of e.detail.split('\n').slice(1)) {
          const lm = LIMIT_LINE.exec(l);
          if (lm) limits.push({ namespace: currentNs, name: lm[1]!.trim(), used: Number(lm[2]), max: Number(lm[3]) });
        }
        break;
      }
      case 'CODE_UNIT_STARTED':
        codeUnits.push(e.detail.split('|').pop()!.trim());
        break;
      case 'FLOW_ELEMENT_BEGIN':
        flowElements.push(e.detail.split('|').slice(-2).join(' ').trim());
        break;
    }
  }

  // Keep only the last LIMIT_USAGE_FOR_NS block per namespace (the cumulative totals).
  const latest = new Map<string, LimitUsage>();
  for (const l of limits) latest.set(`${l.namespace}|${l.name}`, l);

  const nanos = events.map((e) => e.nanos).filter((n): n is number => n !== undefined);
  const durationMs = nanos.length > 1 ? Math.round((Math.max(...nanos) - Math.min(...nanos)) / 1e6) : undefined;

  return {
    ...(apiVersion ? { apiVersion } : {}),
    ...(logLevels ? { logLevels } : {}),
    events,
    countsByType,
    errors: events.filter((e) => ERROR_TYPES.has(e.type)),
    debugStatements: events.filter((e) => e.type === 'USER_DEBUG'),
    soql,
    dml,
    limits: [...latest.values()],
    codeUnits,
    flowElements,
    truncated: /\*\*\* Skipped \d+ bytes of detailed log|MAXIMUM DEBUG LOG SIZE REACHED/.test(body),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** Limits at or above this share of their maximum are highlighted. */
export function limitsNearMax(limits: LimitUsage[], threshold = 0.7): LimitUsage[] {
  return limits.filter((l) => l.max > 0 && l.used / l.max >= threshold);
}
