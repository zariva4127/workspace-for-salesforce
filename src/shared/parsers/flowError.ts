/**
 * Rule-based Flow error translator. Accepts pasted flow fault emails, screen-flow
 * error messages, or record-save errors, and extracts structured details plus
 * possible causes and verification steps. Runs entirely locally — no AI, no network.
 */
import { isSalesforceId } from '../salesforce/ids';

export interface FlowIssue {
  code: string;
  title: string;
  explanation: string;
  causes: string[];
  verify: string[];
  /** The raw message fragment that triggered the rule. */
  evidence: string;
}

export interface FlowErrorAnalysis {
  empty: boolean;
  flowApiName?: string;
  flowLabel?: string;
  flowVersion?: string;
  flowType?: string;
  elementName?: string;
  elementType?: string;
  elementTypeLabel?: string;
  interviewGuid?: string;
  errorId?: string;
  currentUser?: string;
  orgId?: string;
  recordIds: string[];
  issues: FlowIssue[];
  /** Generic steps that apply to every flow failure. */
  generalSteps: string[];
  /** True when no specific rule matched and the explanation is generic. */
  uncertain: boolean;
}

const ELEMENT_TYPES: Record<string, string> = {
  FlowRecordUpdate: 'Update Records',
  FlowRecordCreate: 'Create Records',
  FlowRecordLookup: 'Get Records',
  FlowRecordDelete: 'Delete Records',
  FlowActionCall: 'Action',
  FlowApexPluginCall: 'Apex Plug-in',
  FlowAssignment: 'Assignment',
  FlowDecision: 'Decision',
  FlowLoop: 'Loop',
  FlowScreen: 'Screen',
  FlowSubflow: 'Subflow',
  FlowWait: 'Pause',
  FlowCustomError: 'Custom Error',
  FlowCollectionProcessor: 'Collection Filter/Sort',
  FlowTransform: 'Transform',
};

interface Rule {
  code: string;
  re: RegExp;
  build: (m: RegExpExecArray) => Omit<FlowIssue, 'code' | 'evidence'>;
}

const RULES: Rule[] = [
  {
    code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION',
    re: /FIELD_CUSTOM_VALIDATION_EXCEPTION:?\s*([^.\n]*)/,
    build: (m) => ({
      title: 'A validation rule blocked the save',
      explanation: `A validation rule on the record rejected the change${m[1] ? `: "${m[1].trim()}"` : ''}.`,
      causes: [
        'The flow sets field values that violate a validation rule.',
        'A required value is blank at the moment the flow saves the record.',
        'The validation rule does not exempt automation or the running user.',
      ],
      verify: [
        'Find the validation rule whose error message matches, in Object Manager → Validation Rules.',
        'Compare the rule formula with the values the flow assigns in the failing element.',
        'Debug the flow with the same record to see the values at save time.',
      ],
    }),
  },
  {
    code: 'REQUIRED_FIELD_MISSING',
    re: /REQUIRED_FIELD_MISSING:?\s*([^\n]*)/,
    build: (m) => ({
      title: 'A required field is missing',
      explanation: `The record could not be saved because a required field has no value${m[1] ? ` (${m[1].trim()})` : ''}.`,
      causes: ['The Create/Update element does not set a field that is required at the field or layout level.', 'A variable used for the field value is empty.'],
      verify: ['Check which fields are required on the object (Object Manager → Fields, "Required").', 'Confirm the element maps a non-empty value to each required field.'],
    }),
  },
  {
    code: 'INSUFFICIENT_ACCESS',
    re: /(INSUFFICIENT_ACCESS(?:_OR_READONLY|_ON_CROSS_REFERENCE_ENTITY)?)/,
    build: (m) => ({
      title: 'The running user lacks access',
      explanation:
        m[1] === 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY'
          ? 'The user cannot access a record referenced by a lookup the flow sets (for example the new owner or parent).'
          : 'The user running the flow cannot create, edit, or read this record or field.',
      causes: [
        'The flow runs in user context ("Run in user or system context" / screen flows default to user context).',
        'Object permissions, field-level security, or sharing do not grant the user access.',
        'The record is locked (approval process) or read-only for this user.',
      ],
      verify: [
        'Use Access → Access explainer for the running user, object, field, and record.',
        'Check the flow’s "How to Run the Flow" setting in Flow Builder → Advanced.',
        'Check whether the record is locked by an approval process.',
      ],
    }),
  },
  {
    code: 'UNABLE_TO_LOCK_ROW',
    re: /UNABLE_TO_LOCK_ROW/,
    build: () => ({
      title: 'Record lock contention',
      explanation: 'Another transaction was updating the same record (or its parent) at the same time.',
      causes: ['Bulk loads or integrations updating many children of the same parent.', 'Several automations updating the same parent record concurrently.'],
      verify: ['Check integration or data-load timing around the failure.', 'Retry the operation; if frequent, reduce parent updates or batch sizes.'],
    }),
  },
  {
    code: 'SOQL_LIMIT',
    re: /Too many SOQL queries:?\s*(\d+)?/i,
    build: () => ({
      title: 'SOQL query limit exceeded (101)',
      explanation: 'The transaction ran more than 100 queries. Flows share governor limits with triggers and other automation in the same transaction.',
      causes: ['A Get Records element inside a Loop.', 'Record-triggered flows recursively updating records.', 'Many automations on the same object in one transaction.'],
      verify: ['Look for Get Records, Create, Update, or Delete elements inside loops.', 'Review the debug log (Development → Debug logs) for LIMIT_USAGE and the SOQL count.'],
    }),
  },
  {
    code: 'DML_LIMIT',
    re: /Too many DML (?:statements|rows):?\s*(\d+)?/i,
    build: () => ({
      title: 'DML limit exceeded',
      explanation: 'The transaction exceeded 150 DML statements or 10,000 DML rows.',
      causes: ['Create/Update/Delete elements inside a Loop.', 'Recursive record-triggered automation.'],
      verify: ['Move DML elements outside loops and operate on collections.', 'Check the debug log for DML_BEGIN counts.'],
    }),
  },
  {
    code: 'CPU_LIMIT',
    re: /Apex CPU time limit exceeded/i,
    build: () => ({
      title: 'CPU time limit exceeded',
      explanation: 'The transaction used more than 10 seconds (synchronous) of CPU across all automation.',
      causes: ['Large loops or complex formulas evaluated many times.', 'Several flows and triggers on the same object.'],
      verify: ['Profile the transaction with a debug log (CUMULATIVE_LIMIT_USAGE).', 'Consider asynchronous paths or scheduled paths for heavy work.'],
    }),
  },
  {
    code: 'ITERATION_LIMIT',
    re: /Number of iterations exceeded|exceeded the maximum number of (?:executed elements|iterations)/i,
    build: () => ({
      title: 'Flow element execution limit exceeded',
      explanation: 'The flow executed too many elements in one interview (for example a very large loop).',
      causes: ['Looping over a large collection.', 'A loop with no exit condition.'],
      verify: ['Check loop collection sizes.', 'Use collection filters or bulk-friendly elements instead of per-item logic.'],
    }),
  },
  {
    code: 'NULL_VALUE',
    re: /(?:failed to access the value for ([\w.]+) because it hasn'?t been set or assigned|null reference|Attempt to de-reference a null object)/i,
    build: (m) => ({
      title: 'A value was empty (null)',
      explanation: m[1] ? `The flow read "${m[1]}", which had no value at that point.` : 'The flow or invoked Apex used a value that was empty.',
      causes: ['A Get Records element found no records, and the flow did not check for that.', 'A lookup field used in a formula or path is blank.'],
      verify: ['Add a Decision after Get Records that checks "Is Null = False".', 'Debug the flow with a record where the lookup is blank.'],
    }),
  },
  {
    code: 'INVALID_CROSS_REFERENCE_KEY',
    re: /INVALID_CROSS_REFERENCE_KEY:?\s*([^\n]*)/,
    build: () => ({
      title: 'Invalid record reference',
      explanation: 'A lookup or ID field was set to an ID that does not exist, is the wrong type, or is not accessible.',
      causes: ['A hard-coded ID from another org (IDs differ between sandbox and production).', 'An ID variable holding a record of the wrong object type.'],
      verify: ['Search the flow for hard-coded IDs; use Get Records by name/developer name instead.', 'Check the ID value in the flow debug output.'],
    }),
  },
  {
    code: 'MIXED_DML_OPERATION',
    re: /MIXED_DML_OPERATION/,
    build: () => ({
      title: 'Mixed setup and non-setup DML',
      explanation: 'The transaction updated setup objects (User, Group, PermissionSetAssignment…) and regular records together.',
      causes: ['Creating a user or permission assignment in the same transaction as record changes.'],
      verify: ['Move setup-object changes to an asynchronous path or a separate transaction.'],
    }),
  },
  {
    code: 'STRING_TOO_LONG',
    re: /STRING_TOO_LONG:?\s*([^\n]*)/,
    build: () => ({
      title: 'Text is longer than the field allows',
      explanation: 'A text value exceeds the target field length.',
      causes: ['Concatenated text or a formula producing long values.'],
      verify: ['Check the field length in Metadata → Objects & fields.', 'Truncate with LEFT() in a formula before assigning.'],
    }),
  },
  {
    code: 'DUPLICATES_DETECTED',
    re: /DUPLICATES_DETECTED|DUPLICATE_VALUE/,
    build: () => ({
      title: 'Duplicate rule or unique field blocked the save',
      explanation: 'A duplicate rule or a unique field rejected the record.',
      causes: ['A matching record already exists.', 'A unique/external ID field value is reused.'],
      verify: ['Check duplicate rules and matching rules for the object.', 'Search for existing records with the same key values.'],
    }),
  },
  {
    code: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY',
    re: /CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:?\s*([^\n]*)/,
    build: () => ({
      title: 'Other automation on the record failed',
      explanation: 'A trigger, flow, or process that runs when this record is saved threw an error. The real cause is in the nested message.',
      causes: ['A trigger or another record-triggered flow failed on the same save.'],
      verify: ['Read the text after CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY for the inner error.', 'Capture a debug log for the running user and reproduce.'],
    }),
  },
  {
    code: 'CANNOT_EXECUTE_FLOW_TRIGGER',
    re: /CANNOT_EXECUTE_FLOW_TRIGGER/,
    build: () => ({
      title: 'A record-triggered flow or process failed',
      explanation: 'Saving the record triggered a flow that failed.',
      causes: ['The triggered flow hit one of the errors listed in its fault email.'],
      verify: ['Find the flow named in the message and check its fault emails or debug log.'],
    }),
  },
  {
    code: 'ENTITY_IS_DELETED',
    re: /ENTITY_IS_DELETED/,
    build: () => ({
      title: 'The record was deleted',
      explanation: 'The flow tried to use a record that has been deleted.',
      causes: ['A scheduled or paused path resumed after the record was deleted.'],
      verify: ['Check the Recycle Bin for the record ID.', 'Add checks before scheduled paths operate on records.'],
    }),
  },
  {
    code: 'FIELD_INTEGRITY_EXCEPTION',
    re: /FIELD_INTEGRITY_EXCEPTION:?\s*([^\n]*)/,
    build: () => ({
      title: 'Invalid field value',
      explanation: 'A field value is not valid for the field (for example a lookup filter or picklist restriction).',
      causes: ['A lookup filter excludes the chosen record.', 'An inactive or restricted picklist value.'],
      verify: ['Check lookup filters and picklist values for the field in Object Manager.'],
    }),
  },
  {
    code: 'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST',
    re: /INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST|bad value for restricted picklist field/i,
    build: () => ({
      title: 'Picklist value not allowed',
      explanation: 'The flow set a restricted picklist to a value that is not in its value set (or not available for the record type).',
      causes: ['Hard-coded picklist text that differs from the API value.', 'Record type does not include the value.'],
      verify: ['Compare the value with the picklist’s API values and record-type assignments.'],
    }),
  },
  {
    code: 'BULK_INVOCABLE_MISMATCH',
    re: /number of results does not match the number of interviews/i,
    build: () => ({
      title: 'Invocable Apex returned the wrong number of results',
      explanation: 'An invocable Apex action must return exactly one result per input when flows run in bulk.',
      causes: ['The @InvocableMethod returns fewer or more items than it received.'],
      verify: ['Review the invocable method: output list size must equal input list size.'],
    }),
  },
  {
    code: 'APEX_EXCEPTION',
    re: /An Apex error occurred:\s*([^\n]*)|(System\.\w+Exception[^\n]*)/,
    build: (m) => ({
      title: 'Invoked Apex threw an exception',
      explanation: `An Apex action called by the flow failed: ${(m[1] ?? m[2] ?? '').trim()}`,
      causes: ['A bug or unhandled case in the Apex class called by an Action element.'],
      verify: ['Capture a debug log and find EXCEPTION_THROWN.', 'Add a fault path to the Action element to handle errors gracefully.'],
    }),
  },
  {
    code: 'UNHANDLED_FAULT',
    re: /unhandled fault has occurred/i,
    build: () => ({
      title: 'Unhandled fault (details hidden from the user)',
      explanation: 'The flow failed and the screen shows only a generic message. The details are in the flow error email or the Failed Flow Interviews list.',
      causes: ['Any element failed without a fault path.'],
      verify: [
        'Ask the admin for the flow error email (sent to the flow’s last modifier or the Apex exception email recipients).',
        'Check Setup → Paused and Failed Flow Interviews.',
        'Search debug logs around the time of the error ID.',
      ],
    }),
  },
];

const GENERAL_STEPS = [
  'Open the flow in Flow Builder and use Debug with the same record and running user.',
  'Check Setup → Process Automation → Paused and Failed Flow Interviews.',
  'Add fault paths to data and action elements so users see a clear message.',
];

function capture(re: RegExp, text: string): string | undefined {
  const m = re.exec(text);
  return m?.[1]?.trim() || undefined;
}

export function translateFlowError(input: string): FlowErrorAnalysis {
  const text = input.replace(/\r\n/g, '\n');
  if (!text.trim()) return { empty: true, recordIds: [], issues: [], generalSteps: [], uncertain: false };

  const elementMatch =
    /Error element ([\w-]+) \((\w+)\)/.exec(text) ??
    /An error occurred at element ([\w-]+) \((\w+)\)/i.exec(text) ??
    /element ([\w-]+) \((Flow\w+)\)/.exec(text);
  const elementName = elementMatch?.[1];
  const elementType = elementMatch?.[2];

  const flowLabel =
    capture(/Flow Label:\s*([^\n]+)/i, text) ??
    capture(/the [“"]([^”"]+)[”"] (?:process|flow) failed/i, text) ??
    capture(/Error Occurred During Flow "([^"]+)"/i, text);

  const recordIds = [...new Set((text.match(/\b[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?\b/g) ?? []).filter((c) => /\d/.test(c) && isSalesforceId(c) && !c.startsWith('00D')))];

  const issues: FlowIssue[] = [];
  for (const rule of RULES) {
    const m = rule.re.exec(text);
    if (m) issues.push({ code: rule.code, evidence: m[0].trim().slice(0, 300), ...rule.build(m) });
  }
  // The generic unhandled-fault rule adds nothing when a specific cause was found.
  const specific = issues.filter((i) => i.code !== 'UNHANDLED_FAULT');
  const finalIssues = specific.length ? specific : issues;

  const flowApiName = capture(/Flow API Name:\s*(\S+)/i, text);
  const flowVersion = capture(/Version:\s*(\d+)/i, text);
  const flowType = capture(/(?:Type|Flow Type):\s*([^\n]+)/i, text);
  const interviewGuid = capture(/Interview GUID:\s*([\w-]+)/i, text);
  const errorId = capture(/Error ID:\s*([-\d]+(?:\s*\(-?\d+\))?)/i, text);
  const currentUser = capture(/Current User:\s*([^\n]+)/i, text);
  const orgId = capture(/\b(00D[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?)\b/, text);

  return {
    empty: false,
    ...(flowApiName ? { flowApiName } : {}),
    ...(flowLabel ? { flowLabel } : {}),
    ...(flowVersion ? { flowVersion } : {}),
    ...(flowType ? { flowType } : {}),
    ...(elementName ? { elementName } : {}),
    ...(elementType ? { elementType, elementTypeLabel: ELEMENT_TYPES[elementType] ?? elementType } : {}),
    ...(interviewGuid ? { interviewGuid } : {}),
    ...(errorId ? { errorId } : {}),
    ...(currentUser ? { currentUser } : {}),
    ...(orgId ? { orgId } : {}),
    recordIds,
    issues: finalIssues,
    generalSteps: GENERAL_STEPS,
    uncertain: finalIssues.length === 0 || finalIssues.every((i) => i.code === 'UNHANDLED_FAULT'),
  };
}
