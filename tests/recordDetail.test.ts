import { describe, expect, it } from 'vitest';
import { filterSections, parseCompactLayout, parseLayout, sectionsFromLayout, sectionsFromMetadata } from '../src/shared/records/layout';
import { addressLines, displayText, formatCurrency, htmlToText, picklistLabels, safeHref } from '../src/shared/records/fieldDisplay';
import type { FieldInfo } from '../src/shared/salesforce/metadata';

const f = (name: string, type: string, over: Partial<FieldInfo> = {}): FieldInfo => ({
  name, label: name, type, length: 80, precision: 0, scale: 0, digits: 0, custom: name.endsWith('__c'), nillable: true, createable: true, updateable: true,
  calculated: false, autoNumber: false, unique: false, externalId: false, defaultedOnCreate: false, nameField: false, permissionable: true, referenceTo: [],
  relationshipName: null, polymorphic: false, cascadeDelete: false, restrictedPicklist: false, picklistValues: [], inlineHelpText: null, compoundFieldName: null,
  controllerName: null, dependentPicklist: false, htmlFormatted: false, ...over,
});

const fields = [
  f('Id', 'id'),
  f('Name', 'string', { nameField: true }),
  f('Phone', 'phone'),
  f('BillingAddress', 'address'),
  f('BillingStreet', 'textarea', { compoundFieldName: 'BillingAddress' }),
  f('BillingCity', 'string', { compoundFieldName: 'BillingAddress' }),
  f('Tier__c', 'picklist', { picklistValues: [{ value: 'G', label: 'Gold', active: true }] }),
  f('Secret__c', 'string'),
  f('OwnerId', 'reference', { referenceTo: ['User'] }),
  f('Notes__c', 'textarea', { length: 32000 }),
  f('CreatedDate', 'datetime'),
];
// The REST record response omits fields the user can't read (Secret__c here).
const values: Record<string, unknown> = { Id: '001', Name: 'Acme', Phone: '555', BillingAddress: { street: '1 Main', city: 'Paris' }, BillingStreet: '1 Main', BillingCity: 'Paris', Tier__c: 'G', OwnerId: '005', Notes__c: null, CreatedDate: '2026-01-01T00:00:00.000+0000' };

const layoutsResponse = {
  layouts: [
    { id: 'L1', detailLayoutSections: [{ heading: 'Wrong layout', layoutRows: [{ layoutItems: [{ layoutComponents: [{ type: 'Field', value: 'Phone' }] }] }] }], relatedLists: [{ name: 'Contacts' }] },
    {
      id: 'L2',
      detailLayoutSections: [
        { heading: 'Account Information', layoutRows: [{ layoutItems: [{ layoutComponents: [{ type: 'Field', value: 'Name' }] }, { layoutComponents: [{ type: 'Field', value: 'Secret__c' }] }] }] },
        { heading: 'Address Information', layoutRows: [{ layoutItems: [{ layoutComponents: [{ type: 'Field', value: 'BillingAddress', components: [{ type: 'Field', value: 'BillingStreet' }] }] }] }] },
        { heading: 'System Information', collapsed: true, layoutRows: [{ layoutItems: [{ layoutComponents: [{ type: 'Field', value: 'CreatedDate' }, { type: 'EmptySpace' }] }] }] },
        { heading: 'Custom Links', layoutRows: [{ layoutItems: [{ layoutComponents: [{ type: 'CustomLink', value: 'x' }] }] }] },
      ],
      relatedLists: [{ name: 'Opportunities' }, { name: 'Cases' }, { name: 'Opportunities' }],
    },
  ],
  recordTypeMappings: [
    { recordTypeId: '012000000000000AAA', layoutId: 'L1', defaultRecordTypeMapping: false },
    { recordTypeId: '0125g000000AbCdAAA', layoutId: 'L2', defaultRecordTypeMapping: true },
  ],
};

describe('page layout sections', () => {
  it('picks the layout mapped to the record type', () => {
    expect(parseLayout(layoutsResponse, '0125g000000AbCd')?.sections[0]?.heading).toBe('Account Information');
    expect(parseLayout(layoutsResponse, '012000000000000AAA')?.sections[0]?.heading).toBe('Wrong layout');
    expect(parseLayout(layoutsResponse)?.sections[0]?.heading).toBe('Account Information'); // default mapping
    expect(parseLayout({ detailLayoutSections: layoutsResponse.layouts[1]!.detailLayoutSections })?.sections).toHaveLength(4);
    expect(parseLayout(layoutsResponse, '0125g000000AbCd')?.relatedLists).toEqual(['Opportunities', 'Cases']);
    expect(parseLayout({ relatedLists: [{ name: 'Contacts' }] })?.relatedLists).toEqual(['Contacts']);
    expect(parseLayout({})).toBeUndefined();
  });

  it('shows only readable fields, keeps layout order, and adds the rest under Other fields', () => {
    const sections = sectionsFromLayout(parseLayout(layoutsResponse, '0125g000000AbCdAAA')!, fields, values);
    expect(sections.map((s) => s.title)).toEqual(['Account Information', 'Address Information', 'System Information', 'Other fields']);
    expect(sections[0]!.fields.map((x) => x.name)).toEqual(['Name']); // Secret__c isn't readable
    expect(sections[1]!.fields.map((x) => x.name)).toEqual(['BillingAddress']);
    expect(sections[2]!.collapsed).toBe(true);
    const other = sections.at(-1)!.fields.map((x) => x.name);
    expect(other).toEqual(['Id', 'Notes__c', 'OwnerId', 'Phone', 'Tier__c']); // no BillingStreet/City (shown via compound)
  });

  it('reads compact layout fields', () => {
    expect(parseCompactLayout({ fieldItems: [{ layoutComponents: [{ type: 'Field', value: 'Name' }] }, { layoutComponents: [{ type: 'Field', value: 'Phone' }] }] })).toEqual(['Name', 'Phone']);
  });
});

describe('metadata fallback sections', () => {
  it('groups fields logically and collapses system info', () => {
    const s = sectionsFromMetadata(fields, values);
    expect(s.map((x) => x.title)).toEqual(['Key information', 'Contact details', 'Addresses', 'Custom fields', 'Descriptions & notes', 'System information']);
    expect(s.find((x) => x.title === 'Addresses')!.fields.map((x) => x.name)).toEqual(['BillingAddress']);
    expect(s.at(-1)!.collapsed).toBe(true);
    expect(s.flatMap((x) => x.fields).some((x) => x.name === 'Secret__c')).toBe(false);
  });

  it('filters by label, API name, or value and can hide empty fields', () => {
    const s = sectionsFromMetadata(fields, values);
    const show = (x: FieldInfo) => displayText(x, values[x.name]);
    expect(filterSections(s, 'gold', show, false).flatMap((x) => x.fields.map((y) => y.name))).toEqual(['Tier__c']);
    expect(filterSections(s, '', show, true).flatMap((x) => x.fields.map((y) => y.name))).not.toContain('Notes__c');
  });
});

describe('value display', () => {
  it('formats picklists, addresses, currency, and rich text', () => {
    expect(picklistLabels(fields[6]!, 'G')).toEqual(['Gold']);
    expect(picklistLabels(f('M', 'multipicklist', { picklistValues: [{ value: 'a', label: 'Alpha', active: true }] }), 'a;b')).toEqual(['Alpha', 'b']);
    expect(addressLines({ street: '1 Main', city: 'Paris', postalCode: '75001', country: 'France' })).toEqual(['1 Main', 'Paris, 75001', 'France']);
    expect(formatCurrency(1234.5, { currency: 'EUR', locale: 'en-US' })).toBe('€1,234.50');
    expect(formatCurrency(1234.5, { locale: 'en-US' })).toBe('1,234.50');
    expect(htmlToText('<p>Hello&nbsp;<b>world</b></p><ul><li>One</li></ul><script>x</script>')).toBe('Hello world\n• One\nx');
    expect(displayText(f('R', 'textarea', { htmlFormatted: true }), '<b>Bold</b> &amp; more')).toBe('Bold & more');
    expect(displayText(f('B', 'boolean'), false)).toBe('No');
  });

  it('only links to web URLs', () => {
    expect(safeHref('www.acme.com')).toBe('https://www.acme.com/');
    expect(safeHref('http://acme.com/x')).toBe('http://acme.com/x');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,hi')).toBeUndefined();
  });
});
