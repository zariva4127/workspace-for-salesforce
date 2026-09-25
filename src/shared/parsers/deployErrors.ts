/**
 * Parses Salesforce CLI deployment output (sf / sfdx, JSON or human-readable)
 * into structured failures with rule-based explanations. Runs entirely locally.
 */

export interface ComponentFailure {
  problemType: 'Error' | 'Warning';
  componentType?: string;
  fullName?: string;
  fileName?: string;
  problem: string;
  line?: number;
  column?: number;
  diagnosis: Diagnosis;
}

export interface TestFailure {
  name: string;
  methodName?: string;
  message: string;
  stackTrace?: string;
  diagnosis: Diagnosis;
}

export interface Diagnosis {
  category: string;
  explanation: string;
  suggestions: string[];
  /** True when this error is usually a side effect of another failure. */
  cascading?: boolean;
}

export interface DeployAnalysis {
  format: 'json' | 'text' | 'empty';
  status?: string;
  topLevelError?: string;
  failures: ComponentFailure[];
  testFailures: TestFailure[];
  coverage: { average?: number; warnings: string[] };
  /** Hints that apply to the deployment as a whole. */
  notes: string[];
}

interface Rule {
  re: RegExp;
  diagnose: (m: RegExpExecArray) => Diagnosis;
}

const RULES: Rule[] = [
  {
    re: /Dependent class is invalid and needs recompilation/i,
    diagnose: () => ({
      category: 'Cascading compile error',
      explanation: 'A class this component depends on failed to compile. This error disappears once the underlying class is fixed.',
      suggestions: ['Fix the other compile errors in this deployment first.', 'If the dependency is not in this deployment, compile it in the target org (Setup → Apex Classes → Compile all classes).'],
      cascading: true,
    }),
  },
  {
    re: /Variable does not exist: ([\w.]+)/i,
    diagnose: (m) => ({
      category: 'Apex compile error',
      explanation: `Apex refers to "${m[1]}", which is not declared or not visible in the target org.`,
      suggestions: [
        'Check the spelling and scope of the variable.',
        `If "${m[1]}" is a field, confirm it exists in the target org and is included in this deployment.`,
        'Deploy dependent metadata (fields, classes) together or before this component.',
      ],
    }),
  },
  {
    re: /Invalid type: ([\w.]+)/i,
    diagnose: (m) => ({
      category: 'Missing dependency',
      explanation: `The type "${m[1]}" (class, object, or inner class) does not exist in the target org.`,
      suggestions: [`Include "${m[1]}" in the deployment, or deploy it first.`, 'Check namespace prefixes for managed-package types.'],
    }),
  },
  {
    re: /No such column '(\w+)' on (?:entity|sobject of type) '?(\w+)'?/i,
    diagnose: (m) => ({
      category: 'Missing field',
      explanation: `SOQL or Apex references ${m[2]}.${m[1]}, which does not exist in the target org (or the deploying user cannot see it).`,
      suggestions: [`Add the field ${m[2]}.${m[1]} to the deployment.`, 'Check the field API name for typos and the __c suffix.', 'Verify field-level security for the deploying user.'],
    }),
  },
  {
    re: /Field (\w+) does not exist/i,
    diagnose: (m) => ({
      category: 'Missing field',
      explanation: `The field "${m[1]}" does not exist on the target object in this org.`,
      suggestions: ['Include the field in the deployment.', 'Confirm the API name and object.'],
    }),
  },
  {
    re: /Entity of type '(\w+)' named '([^']+)' cannot be found/i,
    diagnose: (m) => ({
      category: 'Missing dependency',
      explanation: `The ${m[1]} "${m[2]}" is referenced but not present in the target org.`,
      suggestions: [`Add the ${m[1]} "${m[2]}" to the deployment or deploy it first.`],
    }),
  },
  {
    re: /In field: (\w+) - no (\w+) named ([\w.]+) found/i,
    diagnose: (m) => ({
      category: 'Missing dependency',
      explanation: `The "${m[1]}" setting refers to ${m[2]} "${m[3]}", which does not exist in the target org.`,
      suggestions: [`Include ${m[2]} "${m[3]}" in the deployment.`, 'Remove the reference if the component was intentionally deleted.'],
    }),
  },
  {
    re: /An object '([^']+)' of type (\w+) was named in package\.xml, but was not found in zipped directory/i,
    diagnose: (m) => ({
      category: 'Manifest mismatch',
      explanation: `package.xml lists ${m[2]} "${m[1]}" but its source file is not in the deployment.`,
      suggestions: ['Retrieve or create the component locally, or remove it from package.xml.', 'Check the file path and the -meta.xml suffix.'],
    }),
  },
  {
    re: /Method does not exist or incorrect signature: (.+)/i,
    diagnose: (m) => ({
      category: 'Apex compile error',
      explanation: `The method call "${(m[1] ?? "").trim()}" doesn't match any method visible in the target org.`,
      suggestions: ['Check parameter types and count.', 'Deploy the updated class that defines the method together with its callers.'],
    }),
  },
  {
    re: /(?:Unexpected token|expecting .+ but was|Missing ';'|Extra ';'|unexpected syntax)/i,
    diagnose: () => ({
      category: 'Syntax error',
      explanation: 'The source file has a syntax error.',
      suggestions: ['Open the file at the reported line and column.', 'Run a local compile/lint (e.g. Apex language server) before deploying.'],
    }),
  },
  {
    re: /(?:No MODULE named|Cannot find module|Invalid reference .+ of type module|LWC1\d+)/i,
    diagnose: () => ({
      category: 'LWC import error',
      explanation: 'A Lightning Web Component imports a module, label, schema field, or Apex method that cannot be resolved in the target org.',
      suggestions: ['Check @salesforce/* import paths.', 'Deploy imported Apex classes, custom labels, and fields together with the component.'],
    }),
  },
  {
    re: /Average test coverage across all Apex Classes and Triggers is (\d+)%|test coverage of selected Apex (?:Class|Trigger) is (\d+)%|at least 75% test coverage is required/i,
    diagnose: () => ({
      category: 'Code coverage',
      explanation: 'Production deployments require at least 75% overall Apex coverage, and every trigger needs some coverage.',
      suggestions: [
        'Run the specified tests locally or in a sandbox to see per-class coverage.',
        'Add tests for uncovered classes, or use --test-level RunSpecifiedTests with the right tests.',
      ],
    }),
  },
  {
    re: /(?:cannot be deleted|is referenced by|is in use|referenced elsewhere in salesforce)/i,
    diagnose: () => ({
      category: 'Component in use',
      explanation: 'The component cannot be changed or deleted because other metadata references it.',
      suggestions: ['Use "Where is this used?" in Setup or the Metadata → Dependencies tool.', 'Remove references first, then deploy the deletion (destructiveChangesPost.xml).'],
    }),
  },
  {
    re: /(?:active flow version|flow version .* is active|Cannot update a flow version that is active|The version of the flow you're updating is active)/i,
    diagnose: () => ({
      category: 'Active flow version',
      explanation: 'Active flow versions cannot be overwritten.',
      suggestions: ['Deploy as a new version, or enable "Deploy processes and flows as active" in Setup → Process Automation Settings for production.'],
    }),
  },
  {
    re: /Not available for deploy for this organization/i,
    diagnose: () => ({
      category: 'Feature not enabled',
      explanation: 'The target org does not have the feature, license, or setting required by this metadata type.',
      suggestions: ['Enable the feature in the target org (e.g. in scratch org definition features).', 'Exclude this component from the deployment.'],
    }),
  },
  {
    re: /(?:INSUFFICIENT_ACCESS|insufficient access rights|You do not have permission)/i,
    diagnose: () => ({
      category: 'Permissions',
      explanation: 'The deploying user lacks a permission needed for this component.',
      suggestions: ['Deploying metadata usually requires "Modify Metadata Through Metadata API Functions" or "Modify All Data", plus "Customize Application".'],
    }),
  },
  {
    re: /(?:bad value for restricted picklist|Picklist value .* not found|INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST)/i,
    diagnose: () => ({
      category: 'Picklist value',
      explanation: 'A value is not allowed by a restricted picklist or global value set in the target org.',
      suggestions: ['Deploy the updated picklist or global value set first.', 'Check record type picklist assignments.'],
    }),
  },
  {
    re: /duplicate value found|DUPLICATE_DEVELOPER_NAME|already exists/i,
    diagnose: () => ({
      category: 'Duplicate',
      explanation: 'A component or value with the same unique name already exists.',
      suggestions: ['Rename the component, or retrieve and merge with the existing one.'],
    }),
  },
  {
    re: /(?:UNKNOWN_EXCEPTION|An unexpected error occurred)/i,
    diagnose: () => ({
      category: 'Salesforce internal error',
      explanation: 'Salesforce returned an internal error. It is not caused by a specific line.',
      suggestions: ['Retry the deployment.', 'If it persists, deploy components in smaller batches and contact Salesforce Support with the error ID.'],
    }),
  },
  {
    re: /(?:System\.AssertException|Assertion Failed|System\.\w+Exception)/i,
    diagnose: () => ({
      category: 'Apex test failure',
      explanation: 'An Apex test failed during deployment validation.',
      suggestions: ['Run the test in the target org or a sandbox and read the stack trace.', 'Check test data assumptions (required fields, validation rules, automation) in the target org.'],
    }),
  },
];

const FALLBACK: Diagnosis = {
  category: 'Other',
  explanation: 'No specific rule matched this message.',
  suggestions: ['Open the component at the reported location.', 'Search the exact message in Salesforce Help or the CLI issue tracker.'],
};

export function diagnose(problem: string): Diagnosis {
  for (const rule of RULES) {
    const m = rule.re.exec(problem);
    if (m) return rule.diagnose(m);
  }
  return FALLBACK;
}

/** Test failures fall back to the generic "Apex test failure" diagnosis. */
function diagnoseTest(message: string): Diagnosis {
  const d = diagnose(message);
  return d === FALLBACK ? diagnose('System.Exception') : d;
}

const PATH_TYPES: Array<[RegExp, string]> = [
  [/\/classes\/[^/]+\.cls/, 'ApexClass'],
  [/\/triggers\/[^/]+\.trigger/, 'ApexTrigger'],
  [/\/lwc\//, 'LightningComponentBundle'],
  [/\/aura\//, 'AuraDefinitionBundle'],
  [/\/objects\/[^/]+\/fields\//, 'CustomField'],
  [/\/objects\/[^/]+\/validationRules\//, 'ValidationRule'],
  [/\/objects\/[^/]+\/recordTypes\//, 'RecordType'],
  [/\/objects\//, 'CustomObject'],
  [/\/flows\//, 'Flow'],
  [/\/layouts\//, 'Layout'],
  [/\/permissionsets\//, 'PermissionSet'],
  [/\/profiles\//, 'Profile'],
  [/\/pages\//, 'ApexPage'],
  [/\/flexipages\//, 'FlexiPage'],
];

export function typeFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const p = `/${path.replace(/\\/g, '/')}`;
  return PATH_TYPES.find(([re]) => re.test(p))?.[1];
}

function lineCol(text: string): { line?: number; column?: number } {
  const m =
    /\((\d+):(\d+)\)\s*$/.exec(text) ??
    /\(Line:\s*(\d+),\s*Column:\s*(\d+)\)/i.exec(text) ??
    /line (\d+),? col(?:umn)? (\d+)/i.exec(text);
  return m ? { line: Number(m[1]), column: Number(m[2]) } : {};
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function extractJson(input: string): unknown | undefined {
  const start = input.indexOf('{');
  const end = input.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(input.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parseJson(json: any): DeployAnalysis {
  const result = json.result ?? json;
  const details = result?.details ?? {};
  const failures: ComponentFailure[] = [];
  const seen = new Set<string>();

  const add = (f: Omit<ComponentFailure, 'diagnosis'>) => {
    const key = `${f.componentType}|${f.fullName}|${f.problem}|${f.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    failures.push({ ...f, diagnosis: diagnose(f.problem) });
  };

  for (const c of asArray<any>(details.componentFailures)) {
    add({
      problemType: c.problemType === 'Warning' ? 'Warning' : 'Error',
      componentType: c.componentType || typeFromPath(c.fileName),
      fullName: c.fullName,
      fileName: c.fileName,
      problem: String(c.problem ?? ''),
      ...(num(c.lineNumber) !== undefined ? { line: num(c.lineNumber) } : {}),
      ...(num(c.columnNumber) !== undefined ? { column: num(c.columnNumber) } : {}),
    });
  }
  for (const f of asArray<any>(result?.files)) {
    if (f.state !== 'Failed' || !f.error) continue;
    add({
      problemType: f.problemType === 'Warning' ? 'Warning' : 'Error',
      componentType: f.type || typeFromPath(f.filePath),
      fullName: f.fullName,
      fileName: f.filePath,
      problem: String(f.error),
      ...(num(f.lineNumber) !== undefined ? { line: num(f.lineNumber) } : {}),
      ...(num(f.columnNumber) !== undefined ? { column: num(f.columnNumber) } : {}),
    });
  }

  const rtr = details.runTestResult ?? {};
  const testFailures: TestFailure[] = asArray<any>(rtr.failures).map((t) => ({
    name: t.name,
    methodName: t.methodName,
    message: String(t.message ?? ''),
    stackTrace: t.stackTrace,
    diagnosis: diagnoseTest(String(t.message ?? '')),
  }));
  const coverageWarnings = asArray<any>(rtr.codeCoverageWarnings).map((w) => (w.name ? `${w.name}: ${w.message}` : String(w.message)));

  const topLevelError = json.status && json.status !== 0 && json.message && failures.length === 0 ? String(json.message) : undefined;

  return finalize({
    format: 'json',
    status: result?.status ?? (json.status === 0 ? 'Succeeded' : undefined),
    ...(topLevelError ? { topLevelError } : {}),
    failures,
    testFailures,
    coverage: { warnings: coverageWarnings, ...averageCoverage(JSON.stringify(json)) },
    notes: [],
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function averageCoverage(text: string): { average?: number } {
  const m = /Average test coverage across all Apex Classes and Triggers is (\d+)%/i.exec(text);
  return m ? { average: Number(m[1]) } : {};
}

const ROW_START = /^[\s|│]*(Error|Warning)\b\s{1,}(.+)$/;
const MDAPI_ROW = /^\s*\d+\.\s+(\S+)\s+--\s+(Error|Warning):\s+(.*)$/;
const LINE_COL_CELL = /^\d+:\d+$/;
const METADATA_TYPE = /^[A-Z][A-Za-z]+$/;
const TEST_BULLET = /^\s*[•*-]\s+([\w.]+)\s*$/;

function parseText(input: string): DeployAnalysis {
  const failures: ComponentFailure[] = [];
  const testFailures: TestFailure[] = [];
  const coverageWarnings: string[] = [];
  const lines = input.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.replace(/[│|]\s*$/, '');

    const md = MDAPI_ROW.exec(line);
    if (md) {
      const problem = md[3]!.trim();
      failures.push({
        problemType: md[2] as 'Error' | 'Warning',
        fileName: md[1]!,
        ...(typeFromPath(md[1]) ? { componentType: typeFromPath(md[1])! } : {}),
        problem,
        ...lineCol(problem),
        diagnosis: diagnose(problem),
      });
      continue;
    }

    const row = ROW_START.exec(line);
    if (row) {
      const cells = row[2]!.split(/\s{2,}|\s*[│|]\s*/).map((c) => c.trim()).filter(Boolean);
      if (cells.length === 0) continue;
      let lc: { line?: number; column?: number } = {};
      if (cells.length >= 2 && LINE_COL_CELL.test(cells[cells.length - 1]!)) {
        const [l, c] = cells.pop()!.split(':');
        lc = { line: Number(l), column: Number(c) };
      }
      let componentType: string | undefined;
      let name: string | undefined;
      let problem: string;
      if (cells.length >= 3 && METADATA_TYPE.test(cells[0]!) && !cells[0]!.includes('/')) {
        [componentType, name] = [cells[0], cells[1]];
        problem = cells.slice(2).join(' ');
      } else if (cells.length >= 2) {
        name = cells[0];
        problem = cells.slice(1).join(' ');
      } else {
        problem = cells[0]!;
      }
      // Wrapped problem text continues on following indented lines without a type prefix.
      while (i + 1 < lines.length && /^\s{8,}\S/.test(lines[i + 1]!) && !ROW_START.test(lines[i + 1]!)) {
        problem += ` ${lines[++i]!.trim()}`;
      }
      const isPath = !!name && /[/\\]/.test(name);
      failures.push({
        problemType: row[1] as 'Error' | 'Warning',
        ...(componentType ? { componentType } : isPath && typeFromPath(name) ? { componentType: typeFromPath(name)! } : {}),
        ...(name ? (isPath ? { fileName: name, fullName: baseName(name) } : { fullName: name }) : {}),
        problem,
        ...(lc.line !== undefined ? lc : lineCol(problem)),
        diagnosis: diagnose(problem),
      });
      continue;
    }

    const bullet = TEST_BULLET.exec(line);
    if (bullet && /Test Failures/i.test(lines.slice(Math.max(0, i - 40), i).join('\n'))) {
      const [cls, ...rest] = bullet[1]!.split('.');
      let message = '';
      let stackTrace: string | undefined;
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!) && !TEST_BULLET.test(lines[i + 1]!)) {
        const next = lines[++i]!.trim();
        const mm = /^message:\s*(.*)$/i.exec(next);
        const st = /^stack\s*trace:\s*(.*)$/i.exec(next);
        if (mm) message = mm[1]!;
        else if (st) stackTrace = st[1]!;
        else if (stackTrace !== undefined) stackTrace += `\n${next}`;
        else message += (message ? ' ' : '') + next;
      }
      testFailures.push({
        name: cls!,
        ...(rest.length ? { methodName: rest.join('.') } : {}),
        message,
        ...(stackTrace ? { stackTrace } : {}),
        diagnosis: diagnoseTest(message),
      });
      continue;
    }

    if (/Code coverage issue|test coverage of selected Apex/i.test(line)) coverageWarnings.push(line.trim());
  }

  const status = /Status:\s*(Succeeded|Failed|SucceededPartial|Canceled)/i.exec(input)?.[1];
  const topErr = /^Error \(\d+\):\s*(.+)$/m.exec(input)?.[1] ?? /^ERROR running [^:]+:\s*(.+)$/m.exec(input)?.[1];

  return finalize({
    format: failures.length || testFailures.length || coverageWarnings.length ? 'text' : input.trim() ? 'text' : 'empty',
    ...(status ? { status } : {}),
    ...(topErr && failures.length === 0 ? { topLevelError: topErr } : {}),
    failures,
    testFailures,
    coverage: { warnings: coverageWarnings, ...averageCoverage(input) },
    notes: [],
  });
}

function baseName(path: string): string {
  const file = path.split(/[/\\]/).pop() ?? path;
  return file.replace(/(-meta)?\.xml$/, '').replace(/\.(cls|trigger|js|html|field|object|flow)$/, '');
}

function finalize(a: DeployAnalysis): DeployAnalysis {
  const notes: string[] = [];
  const cascading = a.failures.filter((f) => f.diagnosis.cascading).length;
  if (cascading && cascading < a.failures.length) {
    notes.push(`${cascading} error(s) are cascading side effects. Fix the other errors first; these usually resolve on their own.`);
  }
  if (a.coverage.average !== undefined && a.coverage.average < 75) {
    notes.push(`Average coverage is ${a.coverage.average}%, below the 75% required for production deployments.`);
  }
  if (a.failures.some((f) => f.diagnosis.category === 'Missing dependency' || f.diagnosis.category === 'Missing field')) {
    notes.push('Some components depend on metadata that is missing in the target org. Deploy dependencies together or first.');
  }
  return { ...a, notes: [...a.notes, ...notes] };
}

export function parseDeployOutput(input: string): DeployAnalysis {
  const trimmed = input.trim();
  if (!trimmed) {
    return { format: 'empty', failures: [], testFailures: [], coverage: { warnings: [] }, notes: [] };
  }
  const json = trimmed.includes('{') ? extractJson(trimmed) : undefined;
  if (json && typeof json === 'object') return parseJson(json);
  return parseText(trimmed);
}

/** Groups failures by diagnosis category, putting cascading errors last. */
export function groupByCategory(failures: ComponentFailure[]): Array<{ category: string; items: ComponentFailure[] }> {
  const map = new Map<string, ComponentFailure[]>();
  for (const f of failures) {
    const list = map.get(f.diagnosis.category) ?? [];
    list.push(f);
    map.set(f.diagnosis.category, list);
  }
  return [...map.entries()]
    .map(([category, items]) => ({ category, items }))
    .sort((a, b) => Number(!!a.items[0]!.diagnosis.cascading) - Number(!!b.items[0]!.diagnosis.cascading));
}
