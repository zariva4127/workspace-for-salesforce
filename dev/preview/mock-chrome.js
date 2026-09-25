/*
 * Development-only harness. Provides an in-memory `chrome` API and a fake
 * Salesforce REST API so the real side panel bundle can be exercised in a normal
 * browser tab. Never shipped: it lives outside src/ and dist/.
 *
 * URL options: ?page=record|home|none  &connect=fail|denied  &perm=full|readonly|nodelete|nocreate  &otherTab=0 (hide the second Salesforce tab)
 * Console helpers: previewTouch(id) simulates another user's edit; previewExpire() / previewRestore() toggle an expired session.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const pageKind = params.get('page') ?? 'record';
  const ACC = '001000000000001AAA';
  const TAB_URLS = {
    record: `https://acme.lightning.force.com/lightning/r/Account/${ACC}/view`,
    home: 'https://acme.lightning.force.com/lightning/page/home',
    none: 'https://example.com/',
  };
  if (!params.has('sourceTabId')) {
    params.set('sourceTabId', '1');
    params.set('sourceWindowId', '1');
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }

  // ---- chrome.storage ------------------------------------------------------
  const listeners = new Set();
  const area = (name) => {
    const data = new Map();
    return {
      async get(key) {
        if (key === null || key === undefined) return Object.fromEntries(data);
        const keys = Array.isArray(key) ? key : [key];
        return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: data.get(k), newValue: v };
          data.set(k, structuredClone(v));
        }
        setTimeout(() => listeners.forEach((l) => l(changes, name)));
      },
      async remove(key) {
        for (const k of Array.isArray(key) ? key : [key]) data.delete(k);
        setTimeout(() => listeners.forEach((l) => l({}, name)));
      },
    };
  };
  const event = () => {
    const ls = new Set();
    return { addListener: (f) => ls.add(f), removeListener: (f) => ls.delete(f), fire: (...a) => ls.forEach((f) => f(...a)) };
  };
  const tab = { id: 1, windowId: 1, active: true, title: 'Current tab', url: TAB_URLS[pageKind] ?? TAB_URLS.record };
  // A second Salesforce tab the user can switch to from the connection screen.
  const TABS = new Map([[1, tab]]);
  if (params.get('otherTab') !== '0') TABS.set(2, { id: 2, windowId: 1, active: false, title: 'Edge Communications | Account | Salesforce', url: `https://acme.lightning.force.com/lightning/r/Account/${ACC}/view` });
  TABS.set(4, { id: 4, windowId: 1, active: false, title: 'Google', url: 'https://www.google.com/' });
  let nextTabId = 10;
  const onUpdated = event();

  window.chrome = {
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) } },
    tabs: {
      async get(id) {
        const t = TABS.get(id);
        if (!t) throw new Error('No tab');
        return { ...t };
      },
      async query(q = {}) {
        const all = [...TABS.values()].map((t) => ({ ...t }));
        return q.active ? all.filter((t) => t.id === 1) : all;
      },
      async create({ url }) {
        const t = { id: nextTabId++, windowId: 1, active: false, title: 'New tab', url };
        TABS.set(t.id, t);
        console.info('[preview] open tab', url);
        return { ...t };
      },
      async update(id) {
        return { ...(TABS.get(id) ?? {}) };
      },
      async captureVisibleTab() {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 200;
        const g = c.getContext('2d');
        g.fillStyle = '#0176d3';
        g.fillRect(0, 0, 320, 200);
        g.fillStyle = '#fff';
        g.font = '20px sans-serif';
        g.fillText('Mock screenshot', 70, 105);
        return c.toDataURL('image/jpeg');
      },
      onActivated: event(),
      onUpdated,
    },
    windows: { WINDOW_ID_CURRENT: -2, async getCurrent() { return { id: 1 }; }, async update() { return { id: 1 }; }, onFocusChanged: event() },
    runtime: { getManifest: () => ({ version: '1.1.0-preview' }), getURL: (p) => `/${p}` },
    identity: { getRedirectURL: () => 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/', async launchWebAuthFlow() { throw new Error('OAuth is not available in the preview'); } },
    cookies: {
      async getAllCookieStores() { return [{ id: '0', tabIds: [...TABS.keys()] }]; },
      async getAll({ url }) {
        if (params.get('connect') === 'fail') return [];
        return url && url.includes('salesforce.com') ? [{ name: 'sid', value: '00D000000000001!AQpreviewSessionToken1234567890', domain: 'acme.my.salesforce.com' }] : [];
      },
    },
    sidePanel: { async setPanelBehavior() {} },
  };
  // Records when each loading message appears/disappears (read window.__trace in devtools).
  window.__trace = [];
  const t0 = performance.now();
  new MutationObserver(() => {
    const txt = (document.querySelector('main [role=status]')?.textContent ?? 'ready').trim();
    if (window.__trace.at(-1)?.[1] !== txt) window.__trace.push([Math.round(performance.now() - t0), txt]);
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });

  // Simulate Lightning navigation from the console: previewNavigate('https://acme.lightning.force.com/...')
  window.previewNavigate = (url) => {
    tab.url = url;
    onUpdated.fire(1, { url }, { ...tab });
  };

  // ---- Fake Salesforce (in-memory, writable) ---------------------------------
  const perm = params.get('perm') ?? 'full';
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
  const to18 = (id) => { let s = ''; for (let b = 0; b < 3; b++) { let x = 0; for (let i = 0; i < 5; i++) { const c = id[b * 5 + i]; if (c >= 'A' && c <= 'Z') x |= 1 << i; } s += ALPHA[x]; } return id + s; };
  let seq = 100;
  const newId = (prefix) => to18(prefix + String(seq++).padStart(12, '0'));
  const now = () => new Date().toISOString().replace('Z', '+0000');
  const bits = (...idx) => { let b = 0; for (const i of idx) b |= 0x80 >> i; return btoa(String.fromCharCode(b)); };

  const f = (name, label, type, extra = {}) => ({
    name, label, type, length: ['string', 'email', 'phone', 'url'].includes(type) ? 80 : type === 'textarea' ? 32000 : 0, precision: 0, scale: 0, digits: 0, custom: name.endsWith('__c'), nillable: true,
    createable: true, updateable: true, calculated: false, autoNumber: false, unique: false, externalId: false, defaultedOnCreate: false,
    nameField: false, permissionable: true, referenceTo: [], relationshipName: null, picklistValues: [], restrictedPicklist: false, controllerName: null, dependentPicklist: false, ...extra,
  });
  const ro = { createable: false, updateable: false };
  const pv = (...vals) => vals.map((v) => ({ value: v, label: v, active: true }));
  const obj = (name, label, extra = {}) => ({ name, label, labelPlural: `${label}s`, keyPrefix: null, custom: name.endsWith('__c'), queryable: true, createable: true, updateable: true, deletable: true, searchable: true, layoutable: true, ...extra });
  const canCreate = perm !== 'nocreate' && perm !== 'readonly';
  const GLOBAL = {
    sobjects: [
      obj('Account', 'Account', { keyPrefix: '001', createable: canCreate, updateable: perm !== 'readonly', deletable: perm === 'full' || perm === 'nocreate' }),
      obj('Contact', 'Contact', { keyPrefix: '003' }), obj('Case', 'Case', { keyPrefix: '500' }),
      obj('Opportunity', 'Opportunity', { keyPrefix: '006' }), obj('User', 'User', { keyPrefix: '005', createable: false, deletable: false }), obj('Invoice__c', 'Invoice', { keyPrefix: 'a01' }),
      obj('AccountShare', 'Account Share', { searchable: false }), obj('AccountHistory', 'Account History', { searchable: false, createable: false }),
      obj('AccountFeed', '__MISSING LABEL__ PropertyFile - val AccountFeed not found in section StandardFeedLabel', { searchable: false }),
      obj('AccountContactRole', 'Account Contact Role'),
    ],
  };
  const sobj = (n) => GLOBAL.sobjects.find((o) => o.name.toLowerCase() === n.toLowerCase());
  const DESCRIBE = {
    account: {
      name: 'Account', label: 'Account', keyPrefix: '001', custom: false, queryable: true, recordTypeInfos: [{ recordTypeId: '012000000000000AAA', name: 'Master', master: true, available: true, defaultRecordTypeMapping: true }],
      fields: [
        f('Id', 'Account ID', 'id', { ...ro, permissionable: false }),
        f('Name', 'Account Name', 'string', { nameField: true, permissionable: false, nillable: false, length: 255 }),
        f('Type', 'Account Type', 'picklist', { picklistValues: pv('Prospect', 'Customer - Direct', 'Customer - Channel', 'Partner') }),
        f('Industry', 'Industry', 'picklist', { restrictedPicklist: true, picklistValues: pv('Apparel', 'Electronics', 'Energy', 'Technology') }),
        f('Region__c', 'Region', 'picklist', { picklistValues: pv('EMEA', 'AMER') }),
        f('Country__c', 'Country', 'picklist', { controllerName: 'Region__c', dependentPicklist: true, restrictedPicklist: true, picklistValues: [
          { value: 'France', label: 'France', active: true, validFor: bits(0) }, { value: 'Germany', label: 'Germany', active: true, validFor: bits(0) },
          { value: 'USA', label: 'USA', active: true, validFor: bits(1) }, { value: 'Canada', label: 'Canada', active: true, validFor: bits(1) },
        ] }),
        f('Phone', 'Phone', 'phone', { inlineHelpText: 'Main phone. A validation rule requires 10 digits.' }),
        f('Website', 'Website', 'url'),
        f('Billing_Email__c', 'Billing Email', 'email'),
        f('NumberOfEmployees', 'Employees', 'int', { digits: 8 }),
        f('AnnualRevenue', 'Annual Revenue', 'currency', { precision: 18, scale: 0 }),
        f('Active__c', 'Active', 'boolean', { nillable: false, defaultedOnCreate: true }),
        f('Customer_Since__c', 'Customer Since', 'date'),
        f('Description', 'Description', 'textarea'),
        f('BillingAddress', 'Billing Address', 'address', ro),
        f('BillingStreet', 'Billing Street', 'textarea', { compoundFieldName: 'BillingAddress', length: 255 }),
        f('BillingCity', 'Billing City', 'string', { compoundFieldName: 'BillingAddress', length: 40 }),
        f('BillingPostalCode', 'Billing Zip/Postal Code', 'string', { compoundFieldName: 'BillingAddress', length: 20 }),
        f('BillingCountry', 'Billing Country', 'string', { compoundFieldName: 'BillingAddress', length: 80 }),
        f('Discount__c', 'Discount', 'percent', { precision: 5, scale: 2 }),
        f('Services__c', 'Services', 'multipicklist', { picklistValues: pv('Support', 'Training', 'Consulting') }),
        f('Notes__c', 'Account Notes', 'textarea', { htmlFormatted: true, length: 32768, updateable: false, createable: false }),
        f('Secret_Score__c', 'Secret Score', 'double', { createable: false, updateable: false }),
        f('OwnerId', 'Owner ID', 'reference', { referenceTo: ['User'], relationshipName: 'Owner', nillable: false, defaultedOnCreate: true }),
        f('ParentId', 'Parent Account ID', 'reference', { referenceTo: ['Account'], relationshipName: 'Parent' }),
        f('CreatedById', 'Created By ID', 'reference', { ...ro, referenceTo: ['User'], relationshipName: 'CreatedBy' }),
        f('CreatedDate', 'Created Date', 'datetime', ro), f('LastModifiedDate', 'Last Modified Date', 'datetime', ro),
      ],
      childRelationships: [
        { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts', cascadeDelete: false },
        { childSObject: 'Case', field: 'AccountId', relationshipName: 'Cases', cascadeDelete: false },
        { childSObject: 'Opportunity', field: 'AccountId', relationshipName: 'Opportunities', cascadeDelete: true },
        { childSObject: 'AccountHistory', field: 'AccountId', relationshipName: 'Histories', cascadeDelete: true },
        { childSObject: 'AccountShare', field: 'AccountId', relationshipName: 'Shares', cascadeDelete: true },
        { childSObject: 'AccountFeed', field: 'ParentId', relationshipName: 'Feeds', cascadeDelete: true },
      ],
    },
    user: { name: 'User', label: 'User', keyPrefix: '005', queryable: true, recordTypeInfos: [], fields: [f('Id', 'User ID', 'id', ro), f('Name', 'Full Name', 'string', { ...ro, nameField: true }), f('Username', 'Username', 'string'), f('Email', 'Email', 'email'), f('Title', 'Title', 'string'), f('IsActive', 'Active', 'boolean'),
      f('UserType', 'User Type', 'picklist', { ...ro, picklistValues: pv('Standard', 'PowerPartner', 'CsnOnly', 'Guest') })], childRelationships: [] },
    contact: {
      name: 'Contact', label: 'Contact', keyPrefix: '003', queryable: true, recordTypeInfos: [],
      fields: [f('Id', 'Contact ID', 'id', ro), f('Name', 'Full Name', 'string', { ...ro, nameField: true }), f('FirstName', 'First Name', 'string'), f('LastName', 'Last Name', 'string', { nillable: false }), f('Email', 'Email', 'email'),
        f('AccountId', 'Account ID', 'reference', { referenceTo: ['Account'], relationshipName: 'Account' }), f('CreatedDate', 'Created Date', 'datetime', ro), f('LastModifiedDate', 'Last Modified Date', 'datetime', ro)],
      childRelationships: [],
    },
  };
  for (const [k, d] of Object.entries(DESCRIBE)) Object.assign(d, { createable: sobj(k)?.createable ?? true, updateable: sobj(k)?.updateable ?? true, deletable: sobj(k)?.deletable ?? true });
  const PROFILES = [
    { Id: '00e000000000001AAA', Name: 'System Administrator' }, { Id: '00e000000000002AAA', Name: 'Standard User' },
    { Id: '00e000000000003AAA', Name: 'Minimum Access - API Only' }, { Id: '00e000000000004AAA', Name: 'Partner Community User' },
  ];
  const ROLES = [{ Id: '00E000000000001AAA', Name: 'CFO' }, { Id: '00E000000000002AAA', Name: 'Sales Rep' }, null];
  const FIRST = ['Ana', 'Ben', 'Chen', 'Dana', 'Eli', 'Fatima', 'Gus', 'Hana', 'Ivan', 'Jo', 'Kai', 'Lena', 'Mo', 'Nia', 'Omar'];
  const LAST = ['Lopez', 'Singh', 'Kim', 'Okafor'];
  const USER = { Id: '005000000000001AAA', Name: 'Jordan Rivera', Username: 'jordan.rivera@example.com', Email: 'jordan.rivera@example.com', IsActive: true, UserType: 'Standard', Title: 'CFO', Department: 'Finance',
    ProfileId: PROFILES[0].Id, Profile: { Name: 'System Administrator', UserLicense: { Name: 'Salesforce' } }, UserRoleId: ROLES[0].Id, UserRole: { Name: 'CFO' }, ManagerId: null,
    TimeZoneSidKey: 'America/Los_Angeles', LocaleSidKey: 'en_US', LanguageLocaleKey: 'en_US', LastLoginDate: '2026-09-24T09:00:00.000+0000', CreatedDate: '2025-01-10T09:00:00.000+0000' };
  const USERS = [USER];
  for (let i = 0; i < 59; i++) {
    const prof = i % 9 === 0 ? PROFILES[3] : i % 5 === 0 ? PROFILES[2] : PROFILES[1];
    const role = ROLES[i % 3];
    const name = `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}${i >= 15 ? ` ${Math.floor(i / 15) + 1}` : ''}`;
    USERS.push({ ...USER, Id: to18(`005${String(i + 2).padStart(12, '0')}`), Name: name, Username: `${name.toLowerCase().replace(/ /g, '.')}@acme.com`, Email: `${name.toLowerCase().replace(/ /g, '.')}@acme.com`,
      IsActive: i % 7 !== 3, UserType: prof === PROFILES[3] ? 'PowerPartner' : 'Standard', Title: i % 2 ? 'Account Executive' : 'Support Agent', Department: i % 2 ? 'Sales' : 'Support',
      ProfileId: prof.Id, Profile: { Name: prof.Name, UserLicense: { Name: prof === PROFILES[3] ? 'Partner Community' : 'Salesforce' } }, UserRoleId: role?.Id ?? null, UserRole: role ? { Name: role.Name } : null,
      ManagerId: USER.Id, Manager: { Name: USER.Name }, LastLoginDate: i % 4 === 0 ? null : `2026-09-${String(1 + (i % 23)).padStart(2, '0')}T10:00:00.000+0000`, CreatedDate: `2026-0${1 + (i % 8)}-01T10:00:00.000+0000` });
  }
  function userQuery(q) {
    const where = /FROM User(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?(?: OFFSET (\d+))?$/i.exec(q) ?? [];
    let list = [...USERS];
    const w = where[1] ?? '';
    const like = /Name LIKE '%(.*?)%'/.exec(w)?.[1]?.replace(/\\(.)/g, '$1').toLowerCase();
    if (like) list = list.filter((u) => `${u.Name} ${u.Username} ${u.Email}`.toLowerCase().includes(like));
    if (/IsActive = true/.test(w)) list = list.filter((u) => u.IsActive);
    if (/IsActive = false/.test(w)) list = list.filter((u) => !u.IsActive);
    const prof = /ProfileId = '(\w+)'/.exec(w)?.[1]; if (prof) list = list.filter((u) => u.ProfileId === prof);
    const type = /UserType = '(\w+)'/.exec(w)?.[1]; if (type) list = list.filter((u) => u.UserType === type);
    const id = /(?:^|[\s(])Id = '(\w+)'/.exec(w)?.[1]; if (id) list = list.filter((u) => u.Id.slice(0, 15) === id.slice(0, 15));
    if (/^SELECT COUNT\(\)/i.test(q)) return json({ totalSize: list.length, done: true, records: [] });
    const order = where[2] ?? 'Name ASC';
    if (/^LastLoginDate/.test(order)) list.sort((a, b) => String(b.LastLoginDate ?? '').localeCompare(String(a.LastLoginDate ?? '')));
    else if (/^CreatedDate/.test(order)) list.sort((a, b) => b.CreatedDate.localeCompare(a.CreatedDate));
    else list.sort((a, b) => a.Name.localeCompare(b.Name));
    const off = Number(where[4] ?? 0);
    const lim = Number(where[3] ?? 2000);
    return json({ totalSize: list.length, done: true, records: list.slice(off, off + lim).map((u) => ({ attributes: { type: 'User' }, ...u })) });
  }
  const base = { BillingAddress: null, BillingStreet: null, BillingCity: null, BillingPostalCode: null, BillingCountry: null, Discount__c: null, Services__c: null, Notes__c: null, Type: null, Industry: null, Region__c: null, Country__c: null, Phone: null, Website: null, Billing_Email__c: null, NumberOfEmployees: null, AnnualRevenue: null, Active__c: false, Customer_Since__c: null, Description: null, Secret_Score__c: 7, OwnerId: USER.Id, ParentId: null, CreatedById: USER.Id, CreatedDate: '2026-07-29T21:31:31.000+0000', LastModifiedDate: '2026-09-20T10:00:00.000+0000' };
  const DB = {
    Account: new Map([
      [ACC, { ...base, Id: ACC, Name: 'Edge Communications', Type: 'Customer - Direct', Industry: 'Electronics', Region__c: 'EMEA', Country__c: 'France', Phone: '5127576000', Website: 'http://edgecomm.com', AnnualRevenue: 139000000, Active__c: true, NumberOfEmployees: 1000, Customer_Since__c: '2019-03-15',
        BillingStreet: '312 Constitution Place', BillingCity: 'Austin', BillingPostalCode: '78767', BillingCountry: 'USA', Discount__c: 12.5, Services__c: 'Support;Training',
        Notes__c: '<p>Key <b>strategic</b> account.</p><ul><li>Renewal in Q4</li><li>Executive sponsor: Jane</li></ul>', Description: 'Edge, founded in 1998, is a start-up based in Austin, TX. The company designs and manufactures a device to convert music from one digital format to another. Edge sells its product through retailers and its own website.' }],
      ['001000000000002AAA', { ...base, Id: '001000000000002AAA', Name: 'Burlington Textiles', Type: 'Customer - Direct', Industry: 'Apparel' }],
      ['001000000000003AAA', { ...base, Id: '001000000000003AAA', Name: 'United Oil & Gas', Type: 'Customer - Channel', Industry: 'Energy' }],
    ]),
    Contact: new Map([
      ['003000000000001AAA', { Id: '003000000000001AAA', FirstName: 'Rose', LastName: 'Gonzalez', Name: 'Rose Gonzalez', Email: 'rose@edge.com', AccountId: ACC, CreatedDate: '2026-08-01T10:00:00.000+0000', LastModifiedDate: '2026-08-01T10:00:00.000+0000' }],
      ['003000000000002AAA', { Id: '003000000000002AAA', FirstName: 'Sean', LastName: 'Forbes', Name: 'Sean Forbes', Email: 'sean@edge.com', AccountId: ACC, CreatedDate: '2026-08-02T10:00:00.000+0000', LastModifiedDate: '2026-08-02T10:00:00.000+0000' }],
    ]),
  };
  const syncAddress = (r) => {
    if ('BillingStreet' in r) r.BillingAddress = r.BillingStreet || r.BillingCity ? { street: r.BillingStreet, city: r.BillingCity, postalCode: r.BillingPostalCode, country: r.BillingCountry } : null;
  };
  for (const r of DB.Account.values()) syncAddress(r);
  const deleted = new Set();
  let expired = false;
  window.previewExpire = () => { expired = true; return 'session expired'; };
  window.previewRestore = () => { expired = false; return 'session restored'; };
  window.previewTouch = (id = ACC) => { const r = DB.Account.get(id); r.Phone = '5550001111'; r.LastModifiedDate = now(); return `changed ${r.Name} as another user`; };
  window.previewDB = DB;

  const json = (body, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Sforce-Limit-Info': 'api-usage=64/15000' } });
  const rows = (records) => json({ totalSize: records.length, done: true, records });
  const err = (status, errorCode, message, fields = []) => json([{ errorCode, message, fields }], status);
  const all = (t) => (t === 'User' ? USERS : [...(DB[t]?.values() ?? [])]);
  const withRel = (t, r) => (t === 'Account' ? { ...r, Owner: { Name: USERS.find((u) => u.Id === r.OwnerId)?.Name }, Parent: r.ParentId ? { Name: DB.Account.get(r.ParentId)?.Name } : null } : r);
  const pick = (r, fields) => Object.fromEntries([['attributes', {}], ...fields.map((p) => { const [a, b] = p.split('.'); return b ? [a, r[a] ? { attributes: {}, [b]: r[a][b] } : null] : [a, r[a] ?? null]; })]);

  function query(q) {
    if (/FROM Organization/i.test(q)) return rows([{ Id: '00D000000000001AAA', Name: 'Acme Dev', IsSandbox: false, OrganizationType: 'Developer Edition', InstanceName: 'CAN98', TrialExpirationDate: null, NamespacePrefix: null, DefaultCurrencyIsoCode: 'USD' }]);
    if (/FROM UserRecordAccess/i.test(q)) {
      const edit = perm !== 'readonly';
      const del = perm === 'full' || perm === 'nocreate';
      return rows([{ RecordId: ACC, HasReadAccess: true, HasEditAccess: edit, HasDeleteAccess: del, HasTransferAccess: del, HasAllAccess: del, MaxAccessLevel: del ? 'All' : edit ? 'Edit' : 'Read' }]);
    }
    if (/FROM RecentlyViewed/i.test(q)) {
      const items = [...all('Account').slice(0, 2).map((a) => ({ Id: a.Id, Name: a.Name, Type: 'Account' })), ...all('Contact').slice(0, 1).map((c) => ({ Id: c.Id, Name: c.Name, Type: 'Contact' }))];
      const t = /Type = '(\w+)'/.exec(q)?.[1];
      return rows(items.filter((r) => !t || r.Type === t));
    }
    if (/FROM PermissionSetAssignment/i.test(q)) return rows([
      { PermissionSetId: '0PS000000000001AAA', PermissionSet: { Name: 'X00e000000000001', Label: 'System Administrator', IsOwnedByProfile: true, Profile: { Name: 'System Administrator' } } },
      { PermissionSetId: '0PS000000000002AAA', PermissionSetGroupId: '0PG000000000001AAA', PermissionSet: { Name: 'Support_Team_agg', Label: 'Support Team' }, PermissionSetGroup: { MasterLabel: 'Support Team', DeveloperName: 'Support_Team' } },
      { PermissionSetId: '0PS000000000003AAA', PermissionSet: { Name: 'Sales_Ops', Label: 'Sales Ops', License: { Name: 'Salesforce' } } },
      { PermissionSetId: '0PS000000000004AAA', PermissionSet: { Name: 'Break_Glass', Label: 'Break Glass Admin', HasActivationRequired: true }, ExpirationDate: '2026-12-31T00:00:00.000+0000' },
    ]);
    if (/FROM PermissionSetLicenseAssign/i.test(q)) return rows([{ PermissionSetLicense: { MasterLabel: 'Sales Cloud Einstein' } }]);
    if (/FROM GroupMember/i.test(q)) return rows([{ GroupId: '00G000000000001AAA', Group: { Name: 'All Sales', Type: 'Regular' } }, { GroupId: '00G000000000002AAA', Group: { Name: 'Tier 2 Support', Type: 'Queue' } }]);
    if (/FROM Profile/i.test(q)) return rows(PROFILES);
    if (/FROM PermissionSet WHERE Id IN/i.test(q) && /PermissionsAuthorApex/.test(q)) return rows([
      { Id: '0PS000000000001AAA', PermissionsModifyAllData: true, PermissionsViewAllData: true, PermissionsViewSetup: true, PermissionsManageUsers: true, PermissionsCustomizeApplication: true, PermissionsAuthorApex: true, PermissionsApiEnabled: true, PermissionsViewAllUsers: true },
      { Id: '0PS000000000003AAA', PermissionsApiEnabled: true },
      { Id: '0PS000000000004AAA', PermissionsModifyAllData: true },
    ]);
    if (/FROM User\b/i.test(q) && !/UserRecordAccess/i.test(q)) return userQuery(q);
    if (/FROM ObjectPermissions/i.test(q)) return rows([{ Id: 'x', ParentId: '0PS000000000001AAA', PermissionsRead: true, PermissionsCreate: true, PermissionsEdit: true, PermissionsDelete: true, PermissionsViewAllRecords: true, PermissionsModifyAllRecords: true }]);
    if (/FROM PermissionSet /i.test(q)) return rows([{ Id: '0PS000000000001AAA', PermissionsViewAllData: true, PermissionsModifyAllData: true }]);
    if (/FROM FieldPermissions/i.test(q)) return rows([{ ParentId: '0PS000000000001AAA', PermissionsRead: true, PermissionsEdit: true }]);
    if (/FROM ApexLog/i.test(q)) return rows([{ Id: '07L000000000001AAA', LogUser: { Name: 'Jordan Rivera' }, Operation: '/aura', Request: 'Api', Status: 'Success', LogLength: 20480, StartTime: '2026-09-24T14:00:00.000+0000', DurationMilliseconds: 120 }]);
    const m = /^SELECT (COUNT\(\)|.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY .+?)?(?: LIMIT (\d+))?$/i.exec(q.trim());
    if (!m) return rows([]);
    const [, sel, table, where, limit] = m;
    let list = all(table).map((r) => withRel(table, r));
    if (where) {
      const eq = /(\w+) = '([^']*)'/.exec(where);
      const like = /(\w+) LIKE '%(.*)%'/.exec(where);
      if (eq) list = list.filter((r) => String(r[eq[1]] ?? '').slice(0, 15) === eq[2].slice(0, 15) || r[eq[1]] === eq[2]);
      if (like) list = list.filter((r) => String(r[like[1]] ?? '').toLowerCase().includes(like[2].replace(/\\/g, '').toLowerCase()));
    }
    if (sel.toUpperCase() === 'COUNT()') return json({ totalSize: list.length, done: true, records: [] });
    if (limit) list = list.slice(0, Number(limit));
    return rows(list.map((r) => pick(r, sel.split(',').map((x) => x.trim()))));
  }

  function validate(table, body, existing) {
    const merged = { ...(existing ?? {}), ...body };
    const errors = [];
    if (table === 'Account' && !String(merged.Name ?? '').trim()) errors.push({ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]', fields: ['Name'] });
    if (table === 'Contact' && !String(merged.LastName ?? '').trim()) errors.push({ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [LastName]', fields: ['LastName'] });
    if (merged.Phone && String(merged.Phone).replace(/\D/g, '').length !== 10) errors.push({ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Phone must have exactly 10 digits.', fields: ['Phone'] });
    if (table === 'Account' && merged.Type === 'Partner' && !merged.Website) errors.push({ errorCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Partners need a website before they can be saved.', fields: [] });
    return errors;
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), location.href);
    if (!url.hostname.endsWith('salesforce.com')) return realFetch(input, init);
    await new Promise((r) => setTimeout(r, 150));
    const headers = new Headers(init.headers);
    const auth = headers.get('Authorization');
    if (expired || (!auth && !url.pathname.includes('/Soap/'))) return err(401, 'INVALID_SESSION_ID', 'Session expired or invalid');
    if (params.get('connect') === 'denied') return err(403, 'API_DISABLED_FOR_ORG', 'API is not enabled for this Organization or Partner');
    const method = (init.method ?? 'GET').toUpperCase();
    const p = url.pathname;
    if (p === '/services/oauth2/userinfo') return json({ user_id: USER.Id, organization_id: '00D000000000001AAA', preferred_username: USER.Username });
    if (p === '/services/data/' || p === '/services/data') return json([{ version: '62.0', label: 'Winter 25', url: '/services/data/v62.0' }]);
    if (p.endsWith('/limits')) return json({ DailyApiRequests: { Max: 15000, Remaining: 14936 } });
    if (/\/query\/?$/.test(p)) return query(url.searchParams.get('q') ?? '');
    if (/\/search\/?$/.test(p)) {
      const term = /FIND \{(.+?)\}/.exec(url.searchParams.get('q') ?? '')?.[1]?.replace(/\\/g, '').toLowerCase() ?? '';
      const hits = [...all('Account').filter((a) => a.Name.toLowerCase().includes(term)).map((a) => ({ attributes: { type: 'Account' }, Id: a.Id, Name: a.Name })),
        ...all('Contact').filter((c) => c.Name.toLowerCase().includes(term)).map((c) => ({ attributes: { type: 'Contact' }, Id: c.Id, Name: c.Name, Email: c.Email }))];
      return json({ searchRecords: hits });
    }
    if (/\/sobjects\/?$/.test(p)) return json(GLOBAL);
    const lay = /\/sobjects\/(\w+)\/describe\/layouts\/?(\w*)$/.exec(p);
    if (lay) {
      if (lay[1] !== 'Account') return err(404, 'NOT_FOUND', 'No layouts for this object');
      const sec = (heading, names, extra = {}) => ({ heading, useHeading: true, ...extra, layoutRows: names.map((n) => ({ layoutItems: [{ layoutComponents: [{ type: 'Field', value: n }] }] })) });
      return json({
        layouts: [{ id: '00h000000000001AAA', detailLayoutSections: [
          sec('Account Information', ['Name', 'OwnerId', 'ParentId', 'Type', 'Industry', 'Active__c', 'Phone', 'Website', 'Billing_Email__c']),
          sec('Financials', ['AnnualRevenue', 'NumberOfEmployees', 'Discount__c', 'Customer_Since__c']),
          sec('Segmentation', ['Region__c', 'Country__c', 'Services__c']),
          sec('Address Information', ['BillingAddress']),
          sec('Description Information', ['Description', 'Notes__c']),
          sec('System Information', ['CreatedById', 'CreatedDate', 'LastModifiedDate'], { collapsed: true }),
        ] }],
        recordTypeMappings: [{ recordTypeId: '012000000000000AAA', layoutId: '00h000000000001AAA', defaultRecordTypeMapping: true, available: true }],
      });
    }
    const compact = /\/sobjects\/(\w+)\/describe\/compactLayouts\/primary$/.exec(p);
    if (compact) {
      if (compact[1] !== 'Account') return err(404, 'NOT_FOUND', 'No compact layout');
      return json({ fieldItems: ['Name', 'Type', 'Phone', 'OwnerId', 'AnnualRevenue', 'Industry'].map((n) => ({ layoutComponents: [{ type: 'Field', value: n }] })) });
    }
    const desc = /\/sobjects\/(\w+)\/describe\/?$/.exec(p);
    if (desc) return DESCRIBE[desc[1].toLowerCase()] ? json(DESCRIBE[desc[1].toLowerCase()]) : err(404, 'NOT_FOUND', 'The requested resource does not exist');
    const create = /\/sobjects\/(\w+)\/?$/.exec(p);
    if (create && method === 'POST') {
      const t = create[1];
      if (!sobj(t)?.createable) return err(403, 'INSUFFICIENT_ACCESS_OR_READONLY', `You don't have permission to create ${t} records.`);
      const body = JSON.parse(init.body || '{}');
      const errors = validate(t, body);
      if (errors.length) return json(errors, 400);
      const id = newId(t === 'Account' ? '001' : '003');
      const rec = { ...(t === 'Account' ? base : {}), ...body, Id: id, CreatedDate: now(), LastModifiedDate: now() };
      if (t === 'Contact') rec.Name = [rec.FirstName, rec.LastName].filter(Boolean).join(' ');
      DB[t].set(id, rec);
      return json({ id, success: true, errors: [] }, 201);
    }
    const one = /\/sobjects\/(\w+)\/(\w{15,18})$/.exec(p);
    if (one) {
      const [, t, id] = one;
      const table = DB[t];
      const rec = table?.get(id) ?? (t === 'User' ? USERS.find((u) => u.Id === id) : undefined);
      if (!rec) return deleted.has(id) ? err(404, 'ENTITY_IS_DELETED', 'entity is deleted') : err(404, 'NOT_FOUND', 'The requested resource does not exist');
      const since = headers.get('If-Unmodified-Since');
      const changedSince = since && Date.parse(rec.LastModifiedDate.replace('+0000', 'Z')) > Date.parse(since) + 999;
      if (method === 'GET') return json({ attributes: { type: t }, ...rec });
      if (method === 'PATCH') {
        if (perm === 'readonly') return err(403, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id');
        if (changedSince) return new Response(null, { status: 412 });
        const body = JSON.parse(init.body || '{}');
        const errors = validate(t, body, rec);
        if (errors.length) return json(errors, 400);
        Object.assign(rec, body, { LastModifiedDate: now() });
        syncAddress(rec);
        if (t === 'Contact') rec.Name = [rec.FirstName, rec.LastName].filter(Boolean).join(' ');
        return json(null, 204);
      }
      if (method === 'DELETE') {
        if (!sobj(t)?.deletable) return err(403, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id');
        if (changedSince) return new Response(null, { status: 412 });
        table.delete(id);
        deleted.add(id);
        return json(null, 204);
      }
    }
    if (p.endsWith('/Body')) return new Response('62.0 APEX_CODE,FINEST\n12:00:00.001 (1000)|USER_DEBUG|[4]|DEBUG|hello\n', { status: 200 });
    return err(404, 'NOT_FOUND', `Preview has no fixture for ${method} ${p}`);
  };
})();
