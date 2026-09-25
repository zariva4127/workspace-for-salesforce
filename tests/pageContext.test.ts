import { describe, expect, it } from 'vitest';
import { detectPageContext, sameContext } from '../src/shared/context/pageContext';
import { isSalesforceId, sameId, to18 } from '../src/shared/salesforce/ids';

const ACC15 = '001000000000001';
const ACC18 = to18(ACC15);

describe('Salesforce IDs', () => {
  it('computes the 18-character checksum', () => {
    expect(to18('001D000000IqhSL')).toBe('001D000000IqhSLIAZ');
  });
  it('validates 18-character checksums', () => {
    expect(isSalesforceId('001D000000IqhSLIAZ')).toBe(true);
    expect(isSalesforceId('001D000000IqhSLAAA')).toBe(false);
    expect(isSalesforceId('001D000000IqhSL')).toBe(true);
    expect(isSalesforceId('not-an-id')).toBe(false);
    expect(isSalesforceId('Account')).toBe(false);
  });
  it('compares 15 and 18 character forms', () => {
    expect(sameId('001D000000IqhSL', '001D000000IqhSLIAZ')).toBe(true);
  });
});

describe('detectPageContext', () => {
  it('detects a Lightning record page with object and ID', () => {
    const ctx = detectPageContext(`https://acme.lightning.force.com/lightning/r/Account/${ACC15}/view`);
    expect(ctx.isSalesforce).toBe(true);
    expect(ctx.org?.key).toBe('acme');
    expect(ctx.org?.environment).toBe('production');
    expect(ctx.pageType).toBe('record');
    expect(ctx.objectApiName).toBe('Account');
    expect(ctx.recordId).toBe(ACC18);
  });

  it('detects sandbox record pages and custom objects', () => {
    const ctx = detectPageContext(`https://acme--uat.sandbox.lightning.force.com/lightning/r/Invoice__c/${ACC18}/view?ws=%2Flightning`);
    expect(ctx.org?.key).toBe('acme--uat.sandbox');
    expect(ctx.org?.environment).toBe('sandbox');
    expect(ctx.org?.apiHost).toBe('acme--uat.sandbox.my.salesforce.com');
    expect(ctx.objectApiName).toBe('Invoice__c');
  });

  it('detects record pages without an object segment', () => {
    const ctx = detectPageContext(`https://acme.lightning.force.com/lightning/r/${ACC15}/view`);
    expect(ctx.pageType).toBe('record');
    expect(ctx.objectApiName).toBeUndefined();
    expect(ctx.recordId).toBe(ACC18);
  });

  it('detects related lists and edit pages', () => {
    const rel = detectPageContext(`https://acme.lightning.force.com/lightning/r/Account/${ACC15}/related/Contacts/view`);
    expect(rel.pageType).toBe('recordRelated');
    expect(rel.relatedListId).toBe('Contacts');
    const edit = detectPageContext(`https://acme.lightning.force.com/lightning/r/Account/${ACC15}/edit`);
    expect(edit.pageType).toBe('recordEdit');
  });

  it('detects object home, list, and new pages', () => {
    expect(detectPageContext('https://acme.lightning.force.com/lightning/o/Contact/list?filterName=Recent')).toMatchObject({
      pageType: 'objectHome',
      objectApiName: 'Contact',
    });
    expect(detectPageContext('https://acme.lightning.force.com/lightning/o/Case/new')).toMatchObject({ pageType: 'objectNew', objectApiName: 'Case' });
  });

  it('detects Setup and Object Manager pages on the setup domain', () => {
    const om = detectPageContext('https://acme.my.salesforce-setup.com/lightning/setup/ObjectManager/Opportunity/FieldsAndRelationships/view');
    expect(om.org?.key).toBe('acme');
    expect(om).toMatchObject({ pageType: 'objectManager', objectApiName: 'Opportunity' });
    const omId = detectPageContext('https://acme.lightning.force.com/lightning/setup/ObjectManager/01I5g000000abcd/Details/view');
    expect(omId.pageType).toBe('objectManager');
    expect(omId.objectApiName).toBeUndefined();
    expect(detectPageContext('https://acme.lightning.force.com/lightning/setup/Flows/home')).toMatchObject({ pageType: 'setup', setupPage: 'Flows' });
  });

  it('detects Flow Builder with the flow version ID', () => {
    const ctx = detectPageContext('https://acme.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=3015g000000ABCD');
    expect(ctx.pageType).toBe('flowBuilder');
    expect(ctx.flowId).toBe(to18('3015g000000ABCD'));
  });

  it('detects Classic record pages and Visualforce', () => {
    expect(detectPageContext(`https://acme.my.salesforce.com/${ACC15}`)).toMatchObject({ pageType: 'classicRecord', recordId: ACC18 });
    expect(detectPageContext('https://acme.my.salesforce.com/apex/MyPage?id=1')).toMatchObject({ pageType: 'visualforce', appPageName: 'MyPage' });
  });

  it('detects legacy one.app hash URLs', () => {
    const ctx = detectPageContext(`https://acme.lightning.force.com/one/one.app#/sObject/${ACC15}/view`);
    expect(ctx.pageType).toBe('record');
    expect(ctx.recordId).toBe(ACC18);
  });

  it('identifies scratch, developer, and trailhead orgs by domain suffix', () => {
    expect(detectPageContext('https://power-ruby-1234-dev-ed.scratch.lightning.force.com/lightning/page/home').org?.environment).toBe('scratch');
    expect(detectPageContext('https://acme-dev-ed.develop.lightning.force.com/lightning/page/home').org?.environment).toBe('developer');
    expect(detectPageContext('https://fun-bear-1.trailblaze.lightning.force.com/lightning/page/home').org?.environment).toBe('trailhead');
  });

  it('maps Lightning, My Domain, and Setup hosts of one org to one key', () => {
    const keys = [
      'https://acme--uat.sandbox.lightning.force.com/lightning/page/home',
      'https://acme--uat.sandbox.my.salesforce.com/home/home.jsp',
      'https://acme--uat.sandbox.my.salesforce-setup.com/lightning/setup/SetupOneHome/home',
    ].map((u) => detectPageContext(u).org?.key);
    expect(new Set(keys)).toEqual(new Set(['acme--uat.sandbox']));
  });

  it('treats login pages as Salesforce without an org', () => {
    expect(detectPageContext('https://login.salesforce.com/')).toMatchObject({ isSalesforce: true, org: null, pageType: 'login' });
  });

  it('rejects non-Salesforce and look-alike hosts', () => {
    for (const url of [
      'https://example.com/lightning/r/Account/001000000000001/view',
      'https://lightning.force.com.evil.com/lightning/r/Account/001000000000001/view',
      'https://acme.lightning.force.com.evil.com/',
      'http://acme.lightning.force.com/lightning/page/home',
      'chrome://extensions',
      'not a url',
      undefined,
    ]) {
      const ctx = detectPageContext(url);
      expect(ctx.isSalesforce, String(url)).toBe(false);
      expect(ctx.org).toBeNull();
    }
  });

  it('ignores invalid record IDs', () => {
    const ctx = detectPageContext('https://acme.lightning.force.com/lightning/r/Account/001000000000001XYZ/view');
    expect(ctx.recordId).toBeUndefined();
  });

  it('treats Lightning client-side navigation between records as a context change', () => {
    const a = detectPageContext(`https://acme.lightning.force.com/lightning/r/Account/${ACC15}/view`);
    const b = detectPageContext(`https://acme.lightning.force.com/lightning/r/Account/${ACC15}/view?tab=related`);
    const c = detectPageContext('https://acme.lightning.force.com/lightning/r/Contact/003000000000001/view');
    expect(sameContext(a, b)).toBe(true);
    expect(sameContext(a, c)).toBe(false);
  });
});
