/** Returns a credential-safe Salesforce origin, or undefined for lookalike/insecure hosts. */
export function safeSalesforceOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.startsWith('http') ? value : `https://${value.replace(/^\./, '')}`);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase();
    // Setup uses a separate first-party domain. It is a valid source for the
    // signed-in browser session just like Lightning and My Domain pages.
    if (!/(^|\.)(salesforce\.com|salesforce-setup\.com|force\.com)$/.test(host)) return undefined;
    if (['login.salesforce.com', 'test.salesforce.com'].includes(host)) return undefined;
    return url.origin;
  } catch { return undefined; }
}
