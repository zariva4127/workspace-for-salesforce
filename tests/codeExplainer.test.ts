import { describe, expect, it } from 'vitest';
import { explainApex, explainFlow, explainTrigger, flowPath } from '../src/shared/development/codeExplainer';

describe('local code explainer', () => {
  it('finds Apex methods, queries, DML, and dependencies', () => {
    const out = explainApex({ id: '1', kind: 'class', name: 'AccountService' }, 'public class AccountService { public static void run(){ List<Account> a=[SELECT Id FROM Account]; update a; Helper.go(); } }');
    expect(out.sections[0]!.references).toContain('run()');
    expect(out.sections.find((s) => s.title.includes('SOQL'))!.references).toContain('FROM Account');
    expect(out.dependencies).toContain('Helper');
  });
  it('explains trigger timing and handler references', () => {
    const out = explainTrigger({ id: '2', kind: 'trigger', name: 'AccountTrigger' }, 'trigger AccountTrigger on Account (before insert, after update) { AccountTriggerHandler.run(); }');
    expect(out.summary).toContain('before insert');
    expect(out.dependencies).toContain('AccountTriggerHandler');
  });
  it('reports active and inactive Flow versions and supported elements', () => {
    const active = explainFlow({ id: '3', kind: 'flow', name: 'Welcome', status: 'Active', version: 4 }, { decisions: [{ name: 'HasEmail' }], recordUpdates: [{ name: 'UpdateContact' }] });
    const inactive = explainFlow({ id: '4', kind: 'flow', name: 'DraftFlow', status: 'Draft', version: 2 }, { screens: [{ name: 'Intro' }] });
    expect(active.summary).toContain('Active'); expect(active.sections.some((s) => s.references.includes('HasEmail'))).toBe(true);
    expect(inactive.summary).toContain('Draft');
  });
  it('builds a bounded visual Flow path and exposes fault connectors', () => {
    const path = flowPath({
      start: { connector: { targetReference: 'Check' } },
      decisions: [{ name: 'Check', connector: { targetReference: 'Update' }, faultConnector: { targetReference: 'HandleError' } }],
      recordUpdates: [{ name: 'Update' }],
      assignments: [{ name: 'HandleError' }],
    });
    expect(path.map((node) => node.name).slice(0, 2)).toEqual(['Check', 'Update']);
    expect(path[0]!.fault).toBe('HandleError');
  });
});
