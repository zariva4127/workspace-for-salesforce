/** Navigation model: sections (top-level tabs) contain tools (sub-tabs). Used by the nav and by search. */

export type SectionId = 'overview' | 'records' | 'dataTransfer' | 'users' | 'access' | 'flows' | 'apexFlow' | 'development' | 'metadata' | 'settings';

export type ToolId =
  | 'overview'
  | 'recordSearch'
  | 'record'
  | 'dataImport'
  | 'dataExport'
  | 'users'
  | 'access'
  | 'flowErrors'
  | 'formTester'
  | 'soql'
  | 'apexClasses'
  | 'apexTriggers'
  | 'flowsExplorer'
  | 'debugLogs'
  | 'deploy'
  | 'objects'
  | 'mapping'
  | 'dependencies'
  | 'settings';

export interface RouteParams {
  objectApiName?: string;
  fieldApiName?: string;
  recordId?: string;
  userId?: string;
  query?: string;
  explorerName?: string;
}

export interface Route {
  tool: ToolId;
  params?: RouteParams;
}

export interface ToolMeta {
  id: ToolId;
  section: SectionId;
  label: string;
  description: string;
  keywords: string[];
  /** Needs an API connection. Tools without it work offline on pasted text. */
  needsConnection: boolean;
}

export interface SectionMeta {
  id: SectionId;
  label: string;
  /** Compact label for the narrow bottom bar, where the full name would be clipped. */
  short?: string;
  icon: IconName;
}

export type IconName = 'home' | 'record' | 'transfer' | 'users' | 'shield' | 'flow' | 'code' | 'database' | 'gear';

export const SECTIONS: SectionMeta[] = [
  { id: 'overview', label: 'Home', icon: 'home' },
  { id: 'records', label: 'Records', icon: 'record' },
  { id: 'dataTransfer', label: 'Data Import & Export', short: 'Import/Export', icon: 'transfer' },
  { id: 'users', label: 'Users', icon: 'users' },
  { id: 'access', label: 'Access', icon: 'shield' },
  { id: 'flows', label: 'Flows & Forms', short: 'Flows/Forms', icon: 'flow' },
  { id: 'apexFlow', label: 'Apex & Flow Explorer', short: 'Explorer', icon: 'code' },
  { id: 'development', label: 'Development', icon: 'code' },
  { id: 'metadata', label: 'Metadata', icon: 'database' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

export const TOOLS: ToolMeta[] = [
  { id: 'overview', section: 'overview', label: 'Home', description: 'Your saved items, the current page, Setup shortcuts, and org details', keywords: ['org', 'user', 'setup', 'limits', 'environment', 'links', 'saved', 'favorites', 'workspace', 'overview'], needsConnection: false },
  { id: 'recordSearch', section: 'records', label: 'Record search', description: 'Find records by name, number, email, or ID', keywords: ['search', 'find', 'record', 'id', 'recent', 'sosl'], needsConnection: true },
  { id: 'record', section: 'records', label: 'Record details', description: 'Fields, lookups, and related records', keywords: ['record', 'id', 'fields', 'lookup', 'parent', 'child', 'related', 'navigator', 'inspect'], needsConnection: true },
  { id: 'dataImport', section: 'dataTransfer', label: 'Import', description: 'Validate, map, preview, and write CSV rows with confirmation', keywords: ['csv', 'insert', 'update', 'upsert', 'mapping', 'bulk', 'load'], needsConnection: true },
  { id: 'dataExport', section: 'dataTransfer', label: 'Export', description: 'Select fields, filter, preview, and download Salesforce records', keywords: ['csv', 'download', 'extract', 'query', 'filter', 'bulk'], needsConnection: true },
  { id: 'users', section: 'users', label: 'Users', description: 'Find users and see their profile, permission sets, and groups', keywords: ['user', 'users', 'profile', 'permission set', 'group', 'role', 'license', 'people'], needsConnection: true },
  { id: 'access', section: 'access', label: 'Access explainer', description: 'Why a user can or cannot see an object, field, or record', keywords: ['permission', 'profile', 'permission set', 'fls', 'sharing', 'security', 'user'], needsConnection: true },
  { id: 'flowErrors', section: 'flows', label: 'Flow error translator', description: 'Explain a pasted flow error and how to verify it', keywords: ['flow', 'fault', 'error', 'email', 'automation', 'exception'], needsConnection: false },
  { id: 'formTester', section: 'flows', label: 'Form tester', description: 'Record test steps and screenshots, export a bug report', keywords: ['test', 'qa', 'screenshot', 'bug', 'report', 'evidence', 'steps'], needsConnection: false },
  { id: 'soql', section: 'development', label: 'SOQL workspace', description: 'Run read-only SOQL and Tooling queries', keywords: ['soql', 'query', 'select', 'tooling', 'csv', 'export'], needsConnection: true },
  { id: 'apexClasses', section: 'apexFlow', label: 'Apex Classes', description: 'Browse source and understand methods, queries, DML, callouts, and dependencies', keywords: ['apex', 'class', 'methods', 'soql', 'dml', 'explain', 'source'], needsConnection: true },
  { id: 'apexTriggers', section: 'apexFlow', label: 'Apex Triggers', description: 'Inspect trigger events, record effects, and handler classes', keywords: ['apex', 'trigger', 'handler', 'events', 'timing', 'source'], needsConnection: true },
  { id: 'flowsExplorer', section: 'apexFlow', label: 'Flows', description: 'Explore Flow versions, elements, operations, and visual paths', keywords: ['flow', 'automation', 'version', 'decision', 'assignment', 'subflow'], needsConnection: true },
  { id: 'debugLogs', section: 'development', label: 'Debug logs', description: 'Browse and analyze Apex debug logs', keywords: ['debug', 'log', 'apex', 'limits', 'exception'], needsConnection: false },
  { id: 'deploy', section: 'development', label: 'Deployment errors', description: 'Explain pasted Salesforce CLI deployment output', keywords: ['deploy', 'cli', 'sf', 'sfdx', 'error', 'coverage', 'test'], needsConnection: false },
  { id: 'objects', section: 'metadata', label: 'Objects & fields', description: 'Search objects and fields with types and relationships', keywords: ['object', 'field', 'api name', 'describe', 'relationship', 'picklist'], needsConnection: true },
  { id: 'mapping', section: 'metadata', label: 'Field mapping', description: 'Check field-to-field mappings for type mismatches', keywords: ['mapping', 'migration', 'integration', 'type', 'mismatch'], needsConnection: true },
  { id: 'dependencies', section: 'metadata', label: 'Dependencies', description: 'Where a custom field or object is used (may be incomplete)', keywords: ['dependency', 'where used', 'references', 'usage'], needsConnection: true },
  { id: 'settings', section: 'settings', label: 'Settings', description: 'Connection, org names and colors, theme, privacy', keywords: ['settings', 'connect', 'client id', 'color', 'theme', 'privacy', 'disconnect'], needsConnection: false },
];

export function toolsIn(section: SectionId): ToolMeta[] {
  return TOOLS.filter((t) => t.section === section);
}

export function toolMeta(id: ToolId): ToolMeta {
  return TOOLS.find((t) => t.id === id)!;
}

/** Simple ranked search over tool labels, descriptions, and keywords. */
export function searchTools(query: string): ToolMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return TOOLS;
  const terms = q.split(/\s+/);
  return TOOLS.map((t) => {
    const hay = [t.label, t.description, ...t.keywords, t.section].join(' ').toLowerCase();
    if (!terms.every((term) => hay.includes(term))) return { t, score: -1 };
    const score = (t.label.toLowerCase().startsWith(q) ? 10 : 0) + (t.label.toLowerCase().includes(q) ? 5 : 0) + (t.keywords.some((k) => k.startsWith(q)) ? 3 : 0);
    return { t, score };
  })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t);
}
