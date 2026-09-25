/**
 * Salesforce record ID helpers. IDs are 15-character case-sensitive or
 * 18-character case-insensitive (with a 3-character checksum suffix).
 */

const ID_CHARS = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/** Computes the 3-character checksum suffix for a 15-character ID. */
function checksum(id15: string): string {
  let suffix = '';
  for (let block = 0; block < 3; block++) {
    let flags = 0;
    for (let i = 0; i < 5; i++) {
      const ch = id15.charAt(block * 5 + i);
      if (ch >= 'A' && ch <= 'Z') flags |= 1 << i;
    }
    suffix += SUFFIX_ALPHABET.charAt(flags);
  }
  return suffix;
}

/** True for a syntactically valid 15-char ID, or an 18-char ID with a correct checksum. */
export function isSalesforceId(value: string | null | undefined): value is string {
  if (!value || !ID_CHARS.test(value)) return false;
  if (value.length === 15) return true;
  return checksum(value.slice(0, 15)) === value.slice(15).toUpperCase();
}

/** Converts a 15-char ID to its 18-char form. 18-char IDs are returned with a normalized suffix. */
export function to18(id: string): string {
  if (!isSalesforceId(id)) throw new Error(`Not a Salesforce ID: ${id}`);
  const id15 = id.slice(0, 15);
  return id15 + checksum(id15);
}

export function keyPrefix(id: string): string {
  return id.slice(0, 3);
}

/** Compares two IDs regardless of 15/18-character form. */
export function sameId(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || !isSalesforceId(a) || !isSalesforceId(b)) return false;
  return a.slice(0, 15) === b.slice(0, 15);
}

/** Well-known key prefixes that are useful before describeGlobal has loaded. */
export const WELL_KNOWN_PREFIXES: Record<string, string> = {
  '001': 'Account',
  '003': 'Contact',
  '005': 'User',
  '006': 'Opportunity',
  '00Q': 'Lead',
  '500': 'Case',
  '00D': 'Organization',
  '00e': 'Profile',
  '0PS': 'PermissionSet',
  '00T': 'Task',
  '00U': 'Event',
  '701': 'Campaign',
  '800': 'Contract',
  '801': 'Order',
  '01t': 'Product2',
  '300': 'FlowDefinitionView',
  '301': 'Flow',
  '01p': 'ApexClass',
  '01q': 'ApexTrigger',
  '07L': 'ApexLog',
  '0Af': 'DeployRequest',
};
