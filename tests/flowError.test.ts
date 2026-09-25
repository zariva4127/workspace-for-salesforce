import { describe, expect, it } from 'vitest';
import { translateFlowError } from '../src/shared/parsers/flowError';

const FAULT_EMAIL = `Error element Update_Account (FlowRecordUpdate).
The flow tried to update these records: 0015g00000ABCDEAA5. This error occurred: FIELD_CUSTOM_VALIDATION_EXCEPTION: Industry is required for customers. You can look up ExceptionCode values in the SOAP API Developer Guide.

Flow Details
Flow API Name: Account_After_Save
Type: Record-Triggered Flow
Version: 3
Status: Active
Org: Acme (00D5g000004ABCDEAA)

Flow Interview Details
Interview Label: Account After Save 9/24/2026, 10:00 AM
Interview GUID: 1a2b3c4d5e6f-1234
Current User: Jane Doe (0055g00000XYZ12AAA)`;

describe('translateFlowError', () => {
  it('extracts flow details from a fault email', () => {
    const a = translateFlowError(FAULT_EMAIL);
    expect(a).toMatchObject({
      flowApiName: 'Account_After_Save',
      flowVersion: '3',
      elementName: 'Update_Account',
      elementType: 'FlowRecordUpdate',
      elementTypeLabel: 'Update Records',
      interviewGuid: '1a2b3c4d5e6f-1234',
      orgId: '00D5g000004ABCDEAA',
      uncertain: false,
    });
    expect(a.currentUser).toMatch(/Jane Doe/);
    expect(a.recordIds).toContain('0015g00000ABCDEAA5');
    expect(a.recordIds).not.toContain('00D5g000004ABCDEAA');
  });

  it('explains validation rule failures with causes and verification steps', () => {
    const a = translateFlowError(FAULT_EMAIL);
    const issue = a.issues.find((i) => i.code === 'FIELD_CUSTOM_VALIDATION_EXCEPTION');
    expect(issue).toBeDefined();
    expect(issue!.explanation).toMatch(/Industry is required for customers/);
    expect(issue!.causes.length).toBeGreaterThan(0);
    expect(issue!.verify.length).toBeGreaterThan(0);
  });

  it('handles record-save messages from triggered flows', () => {
    const a = translateFlowError(
      'We can\'t save this record because the “Opportunity Stage Sync” process failed. Give your Salesforce admin these details. This error occurred when the flow tried to update records: INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on object id. Error ID: 1234567890-12345 (-987654321)',
    );
    expect(a.flowLabel).toBe('Opportunity Stage Sync');
    expect(a.errorId).toBe('1234567890-12345 (-987654321)');
    expect(a.issues.map((i) => i.code)).toContain('INSUFFICIENT_ACCESS');
  });

  it('recognizes governor limits and null values', () => {
    expect(translateFlowError('Too many SOQL queries: 101').issues[0]!.code).toBe('SOQL_LIMIT');
    const nul = translateFlowError("The flow failed to access the value for myAccount.Name because it hasn't been set or assigned.");
    expect(nul.issues[0]!.code).toBe('NULL_VALUE');
    expect(nul.issues[0]!.explanation).toMatch(/myAccount\.Name/);
  });

  it('prefers specific causes over the generic unhandled fault message', () => {
    const a = translateFlowError('An unhandled fault has occurred in this flow. UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record');
    expect(a.issues.map((i) => i.code)).toEqual(['UNABLE_TO_LOCK_ROW']);
  });

  it('labels generic faults as uncertain', () => {
    const a = translateFlowError('An unhandled fault has occurred in this flow. An unhandled fault has occurred while processing the flow.');
    expect(a.uncertain).toBe(true);
    expect(a.issues[0]!.code).toBe('UNHANDLED_FAULT');
    const none = translateFlowError('Something completely different');
    expect(none.uncertain).toBe(true);
    expect(none.issues).toHaveLength(0);
    expect(none.generalSteps.length).toBeGreaterThan(0);
  });

  it('returns empty for blank input', () => {
    expect(translateFlowError('  ').empty).toBe(true);
  });
});
