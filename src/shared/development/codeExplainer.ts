export type AutomationKind = 'class' | 'flow' | 'trigger';

export interface AutomationItem {
  id: string;
  kind: AutomationKind;
  name: string;
  status?: string;
  version?: number;
  lastModified?: string;
  objectName?: string;
  processType?: string;
}

export interface ExplanationSection {
  title: string;
  text: string;
  references: string[];
  inferred?: boolean;
}

export interface LocalExplanation {
  summary: string;
  sections: ExplanationSection[];
  dependencies: string[];
  limitations: string[];
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

function apexMethods(source: string): string[] {
  return unique([...source.matchAll(/\b(?:public|private|protected|global)\s+(?:static\s+)?(?:[\w<>[\],.?]+)\s+(\w+)\s*\(/g)].map((m) => m[1]!));
}

function apexDependencies(source: string): string[] {
  const builtIns = new Set(['if', 'for', 'while', 'switch', 'catch', 'System', 'String', 'Integer', 'Boolean', 'Date', 'Datetime', 'List', 'Set', 'Map']);
  return unique([...source.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s*\./g)].map((m) => m[1]!).filter((n) => !builtIns.has(n))).slice(0, 30);
}

function queriedObjects(source: string): string[] {
  return unique([...source.matchAll(/\bFROM\s+([A-Za-z][\w.]*)/gi)].map((m) => m[1]!));
}

function changedObjects(source: string): string[] {
  return unique([...source.matchAll(/\b(?:insert|update|upsert|delete|undelete)\s+(?:new\s+)?([A-Za-z][\w]*)/gi)].map((m) => m[1]!));
}

function linesFor(source: string, pattern: RegExp): string[] {
  return source.split(/\r?\n/).flatMap((line, index) => pattern.test(line) ? [`Line ${index + 1}`] : []);
}

export function explainApex(item: AutomationItem, source: string): LocalExplanation {
  const methods = apexMethods(source);
  const reads = queriedObjects(source);
  const writes = changedObjects(source);
  const callouts = /\bHttpRequest\b|\bHttp\s*\.|@future\b|Queueable\b|Database\.executeBatch\b/.test(source);
  const errorHandling = /\btry\s*\{|\bcatch\s*\(|\bfinally\s*\{|\bthrow\s+new\b/.test(source);
  const execution = unique([
    ...(/\bif\s*\(/.test(source) ? ['conditional branches'] : []),
    ...(/\b(?:for|while)\s*\(/.test(source) ? ['loops'] : []),
    ...(/\bswitch\s+on\b/.test(source) ? ['switch branches'] : []),
    ...(/\b(?:Queueable|@future|Database\.executeBatch)\b/.test(source) ? ['asynchronous work'] : []),
  ]);
  const sections: ExplanationSection[] = [
    { title: 'Methods and inputs', text: methods.length ? `Defines ${methods.length} visible method${methods.length === 1 ? '' : 's'}. Their declared parameters are the identifiable inputs.` : 'No callable method declaration was recognized by the local parser.', references: methods.flatMap((m) => [`${m}()`, ...linesFor(source, new RegExp(`\\b${m}\\s*\\(`)).slice(0, 1)]), inferred: !methods.length },
    { title: 'Execution flow', text: execution.length ? `The source contains ${execution.join(', ')}. Read each referenced method for the exact order and conditions.` : 'The source appears mostly linear; no major branch or loop marker was recognized.', references: unique([...linesFor(source, /\b(?:if|for|while|switch)\b/), ...linesFor(source, /\b(?:Queueable|@future|Database\.executeBatch)\b/)]).slice(0, 12), inferred: !execution.length },
    { title: 'SOQL and records read', text: reads.length ? `SOQL reads from ${reads.join(', ')}.` : 'No inline SOQL query was recognized.', references: reads.flatMap((o) => [`FROM ${o}`, ...linesFor(source, new RegExp(`\\bFROM\\s+${o}\\b`, 'i'))]).slice(0, 20), inferred: !reads.length },
    { title: 'DML and records changed', text: writes.length ? `Contains data-change statements involving ${writes.join(', ')}.` : 'No direct DML statement was recognized. Called code may still change records.', references: unique([...writes, ...linesFor(source, /\b(?:insert|update|upsert|delete|undelete)\b/i)]), inferred: !writes.length },
    { title: 'Callouts and asynchronous work', text: callouts ? 'The source contains an HTTP or asynchronous Apex marker. Review the referenced code for destinations and side effects.' : 'No HTTP callout or asynchronous Apex marker was recognized.', references: unique([...['HttpRequest', '@future', 'Queueable', 'Database.executeBatch'].filter((x) => source.includes(x)), ...linesFor(source, /\b(?:HttpRequest|Http\s*\.|Queueable|Database\.executeBatch)\b|@future/)]), inferred: !callouts },
    { title: 'Error handling', text: errorHandling ? 'The source includes explicit exception handling or throwing. Inspect the referenced lines to verify recovery and user-visible behavior.' : 'No explicit try/catch, finally, or throw marker was recognized.', references: linesFor(source, /\b(?:try|catch|finally|throw)\b/), inferred: !errorHandling },
  ];
  return {
    summary: `${item.name} is an Apex class. This local explanation is based only on structural patterns in the retrieved source and does not execute the code.`,
    sections,
    dependencies: apexDependencies(source),
    limitations: ['Dynamic SOQL, reflection, managed-package behavior, and behavior hidden behind called methods may not be detected.'],
  };
}

export function explainTrigger(item: AutomationItem, source: string): LocalExplanation {
  const head = /trigger\s+(\w+)\s+on\s+(\w+)\s*\(([^)]+)\)/i.exec(source);
  const events = head?.[3]?.split(',').map((x) => x.trim()).filter(Boolean) ?? [];
  const handlers = apexDependencies(source).filter((n) => n !== item.name);
  const base = explainApex(item, source);
  return {
    ...base,
    summary: head ? `${head[1]} runs on ${head[2]} during ${events.join(', ')}.` : `${item.name} is an Apex trigger; its declaration could not be fully parsed.`,
    sections: [
      { title: 'Entry point', text: head ? `Runs automatically for ${head[2]} on ${events.join(', ')}.` : 'The trigger declaration was not recognized.', references: head ? [head[0]] : [], inferred: !head },
      ...base.sections.slice(1),
      { title: 'Handler classes', text: handlers.length ? `References ${handlers.join(', ')}. Select an accessible class separately to inspect its implementation.` : 'No separate handler class was confidently identified.', references: handlers, inferred: !handlers.length },
    ],
    dependencies: handlers,
  };
}

export function explainFlow(item: AutomationItem, metadata: unknown): LocalExplanation {
  const root = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  const groups: Array<[string, string]> = [['start', 'Start conditions'], ['variables', 'Inputs and variables'], ['decisions', 'Decisions'], ['assignments', 'Assignments'], ['recordLookups', 'Records read'], ['recordCreates', 'Records created'], ['recordUpdates', 'Records updated'], ['recordDeletes', 'Records deleted'], ['actionCalls', 'Actions'], ['subflows', 'Subflows'], ['screens', 'Screens'], ['waits', 'Waits and pauses']];
  const sections = groups.flatMap(([key, title]) => {
    const value = root[key];
    if (value === undefined) return [];
    const list = Array.isArray(value) ? value : [value];
    const names = list.map((v) => (v && typeof v === 'object' ? String((v as Record<string, unknown>).name ?? (v as Record<string, unknown>).label ?? key) : key));
    return [{ title, text: `${names.length} ${title.toLowerCase()} element${names.length === 1 ? '' : 's'} found in the retrieved definition.`, references: names }];
  });
  return {
    summary: `${item.name} is a ${item.processType ?? 'Flow'} at version ${item.version ?? 'unknown'} (${item.status ?? 'status unavailable'}). The summary is generated locally from the metadata Salesforce returned.`,
    sections: sections.length ? sections : [{ title: 'Definition', text: 'Salesforce returned metadata, but no supported Flow elements were recognized.', references: [], inferred: true }],
    dependencies: unique(sections.filter((s) => /Invoked/.test(s.title)).flatMap((s) => s.references)),
    limitations: ['Unsupported Flow elements and expressions are kept in the raw definition but may not appear in this structural summary.'],
  };
}

export interface FlowPathNode { name: string; type: string; next?: string; fault?: string }

/** Builds a bounded, display-only path from Flow connector metadata. */
export function flowPath(metadata: unknown): FlowPathNode[] {
  const root = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>;
  const collections = ['decisions', 'assignments', 'recordLookups', 'recordCreates', 'recordUpdates', 'recordDeletes', 'actionCalls', 'subflows', 'screens', 'loops', 'waits'];
  const nodes = new Map<string, FlowPathNode>();
  const connectorTarget = (value: unknown) => value && typeof value === 'object' ? String((value as Record<string, unknown>).targetReference ?? '') || undefined : undefined;
  for (const key of collections) {
    const raw = root[key];
    for (const value of raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]) {
      if (!value || typeof value !== 'object') continue;
      const element = value as Record<string, unknown>;
      const name = String(element.name ?? element.label ?? 'Unnamed element');
      nodes.set(name, { name, type: key, next: connectorTarget(element.connector), fault: connectorTarget(element.faultConnector) });
    }
  }
  const start = root.start && typeof root.start === 'object' ? root.start as Record<string, unknown> : undefined;
  const first = connectorTarget(start?.connector);
  const ordered: FlowPathNode[] = [];
  const seen = new Set<string>();
  let current = first;
  while (current && !seen.has(current) && ordered.length < 100) {
    seen.add(current); const node = nodes.get(current); if (!node) break;
    ordered.push(node); current = node.next;
  }
  for (const node of nodes.values()) if (!seen.has(node.name)) ordered.push(node);
  return ordered;
}

export function explanationText(item: AutomationItem, explanation: LocalExplanation): string {
  return [`${item.name} — ${item.kind}`, explanation.summary, ...explanation.sections.flatMap((s) => [`\n${s.title}${s.inferred ? ' (uncertain)' : ''}`, s.text, s.references.length ? `References: ${s.references.join(', ')}` : '']), explanation.dependencies.length ? `\nDependencies\n${explanation.dependencies.join(', ')}` : '', `\nLimitations\n${explanation.limitations.join('\n')}`].filter(Boolean).join('\n');
}
