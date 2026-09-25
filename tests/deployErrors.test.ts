import { describe, expect, it } from 'vitest';
import { groupByCategory, parseDeployOutput, typeFromPath } from '../src/shared/parsers/deployErrors';

describe('parseDeployOutput — JSON', () => {
  it('parses sf project deploy --json component failures', () => {
    const json = JSON.stringify({
      status: 1,
      name: 'FailedDeployError',
      message: 'Deploy failed.',
      result: {
        status: 'Failed',
        details: {
          componentFailures: [
            {
              componentType: 'ApexClass',
              fullName: 'InvoiceService',
              fileName: 'classes/InvoiceService.cls',
              problem: 'Variable does not exist: Amount__c',
              problemType: 'Error',
              lineNumber: '42',
              columnNumber: '9',
            },
            { componentType: 'ApexClass', fullName: 'InvoiceController', problem: 'Dependent class is invalid and needs recompilation:\n Class InvoiceService', problemType: 'Error' },
          ],
          runTestResult: { codeCoverageWarnings: { name: 'InvoiceTrigger', message: 'Test coverage of selected Apex Trigger is 0%' } },
        },
      },
    });
    const a = parseDeployOutput(`Warning: something\n${json}`);
    expect(a.format).toBe('json');
    expect(a.status).toBe('Failed');
    expect(a.failures).toHaveLength(2);
    expect(a.failures[0]).toMatchObject({ componentType: 'ApexClass', fullName: 'InvoiceService', line: 42, column: 9 });
    expect(a.failures[0]!.diagnosis.category).toBe('Apex compile error');
    expect(a.failures[1]!.diagnosis.cascading).toBe(true);
    expect(a.coverage.warnings[0]).toMatch(/InvoiceTrigger/);
    expect(a.notes.join(' ')).toMatch(/cascading/);
    // Cascading errors sort last.
    expect(groupByCategory(a.failures).at(-1)!.category).toBe('Cascading compile error');
  });

  it('parses failed entries from result.files and test failures', () => {
    const a = parseDeployOutput(
      JSON.stringify({
        status: 1,
        result: {
          status: 'Failed',
          files: [
            { state: 'Changed', type: 'ApexClass', fullName: 'Ok' },
            { state: 'Failed', type: 'CustomField', fullName: 'Account.Tier__c', filePath: 'force-app/main/default/objects/Account/fields/Tier__c.field-meta.xml', error: "Entity of type 'GlobalValueSet' named 'Tiers' cannot be found" },
          ],
          details: {
            runTestResult: {
              failures: [{ name: 'InvoiceTest', methodName: 'testTotals', message: 'System.AssertException: Assertion Failed: Expected: 10, Actual: 0', stackTrace: 'Class.InvoiceTest.testTotals: line 20, column 1' }],
            },
          },
        },
      }),
    );
    expect(a.failures).toHaveLength(1);
    expect(a.failures[0]!.diagnosis.category).toBe('Missing dependency');
    expect(a.testFailures[0]).toMatchObject({ name: 'InvoiceTest', methodName: 'testTotals' });
    expect(a.testFailures[0]!.diagnosis.category).toBe('Apex test failure');
  });

  it('reports top-level CLI errors', () => {
    const a = parseDeployOutput(JSON.stringify({ status: 1, name: 'NoOrgFound', message: 'No default environment found.' }));
    expect(a.topLevelError).toBe('No default environment found.');
  });
});

describe('parseDeployOutput — text', () => {
  it('parses the sf table format with line:column cells', () => {
    const text = `Deploying v62.0 metadata to admin@acme.com using the v62.0 SOAP API.
Status: Failed

Component Failures [2]
 Type   Name              Problem                                              Line:Column
 ────── ───────────────── ──────────────────────────────────────────────────── ───────────
 Error  InvoiceService    No such column 'Tier__c' on entity 'Account'.        12:30
 Error  force-app/main/default/lwc/invoiceCard/invoiceCard.js  LWC1503: Invalid reference @salesforce/apex/Missing.get of type module
`;
    const a = parseDeployOutput(text);
    expect(a.format).toBe('text');
    expect(a.status).toBe('Failed');
    expect(a.failures).toHaveLength(2);
    expect(a.failures[0]).toMatchObject({ fullName: 'InvoiceService', line: 12, column: 30 });
    expect(a.failures[0]!.diagnosis.category).toBe('Missing field');
    expect(a.failures[1]).toMatchObject({ componentType: 'LightningComponentBundle', fullName: 'invoiceCard' });
    expect(a.failures[1]!.diagnosis.category).toBe('LWC import error');
  });

  it('parses legacy sfdx tables with type columns and inline positions', () => {
    const text = `=== Component Failures [1]
TYPE   PROJECT PATH                                    PROBLEM
─────  ──────────────────────────────────────────────  ─────────────────────────────
Error  force-app/main/default/classes/Foo.cls          Invalid type: Bar (3:5)`;
    const a = parseDeployOutput(text);
    expect(a.failures[0]).toMatchObject({ componentType: 'ApexClass', fileName: 'force-app/main/default/classes/Foo.cls', line: 3, column: 5 });
    expect(a.failures[0]!.diagnosis.category).toBe('Missing dependency');
  });

  it('parses metadata API numbered output', () => {
    const a = parseDeployOutput('1.  classes/Foo.cls -- Error: Method does not exist or incorrect signature: void run(String) (Line: 7, Column: 3)');
    expect(a.failures[0]).toMatchObject({ componentType: 'ApexClass', line: 7, column: 3 });
    expect(a.failures[0]!.diagnosis.category).toBe('Apex compile error');
  });

  it('parses test failures and coverage', () => {
    const text = `Test Failures [1]
• InvoiceTest.testTotals
  message: System.AssertException: Assertion Failed
  stacktrace: Class.InvoiceTest.testTotals: line 20, column 1

Average test coverage across all Apex Classes and Triggers is 61%, at least 75% test coverage is required.`;
    const a = parseDeployOutput(text);
    expect(a.testFailures[0]).toMatchObject({ name: 'InvoiceTest', methodName: 'testTotals', message: 'System.AssertException: Assertion Failed' });
    expect(a.testFailures[0]!.stackTrace).toMatch(/line 20/);
    expect(a.coverage.average).toBe(61);
    expect(a.notes.join(' ')).toMatch(/below the 75%/);
  });

  it('handles empty and unrecognized input', () => {
    expect(parseDeployOutput('   ').format).toBe('empty');
    const a = parseDeployOutput('Error  MyFlow  Something odd happened');
    expect(a.failures[0]!.diagnosis.category).toBe('Other');
  });

  it('infers metadata types from paths', () => {
    expect(typeFromPath('force-app/main/default/objects/Account/fields/Tier__c.field-meta.xml')).toBe('CustomField');
    expect(typeFromPath('force-app\\main\\default\\flows\\X.flow-meta.xml')).toBe('Flow');
    expect(typeFromPath(undefined)).toBeUndefined();
  });
});
