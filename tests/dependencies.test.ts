import { describe, expect, it } from 'vitest';
import { isDependencyField, isDependencyObject } from '../src/shared/salesforce/dependencies';

describe('dependency component support', () => {
  it('accepts supported custom object API suffixes and rejects standard objects', () => {
    expect(isDependencyObject('Invoice__c')).toBe(true);
    expect(isDependencyObject('ns__Invoice__c')).toBe(true);
    expect(isDependencyObject('Setting__mdt')).toBe(true);
    expect(isDependencyObject('Lead')).toBe(false);
    expect(isDependencyObject('AccountHistory')).toBe(false);
  });

  it('offers only custom fields supported by CustomField Tooling queries', () => {
    expect(isDependencyField('Status__c')).toBe(true);
    expect(isDependencyField('ns__Status__c')).toBe(true);
    expect(isDependencyField('Name')).toBe(false);
    expect(isDependencyField('CreatedDate')).toBe(false);
  });
});
