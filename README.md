# Salesforce Workspace

A Manifest V3 Chrome side-panel workspace for Salesforce admins, developers, and testers. It detects the active Salesforce tab, keeps org data separated, and provides record, access, flow, testing, development, and metadata tools.

## Build and install locally

Requirements: Chrome 116+ and Node.js 20+.

```sh
npm install
npm run check
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this project's `dist` folder. Pin the extension and click its toolbar icon, or press `Alt+Shift+S`, to open Salesforce Workspace in a dedicated window. Chrome's extension menu can still expose the side-panel version when desired.

## Salesforce authentication

Launch the extension from a signed-in Salesforce tab. It reads the `sid` from that tab's exact Chrome cookie store, validates the org and current user with Salesforce, pins access to the originating tab, and keeps the credential only in `chrome.storage.session`. No separate login or client app is normally required. If the source tab closes, changes org, or the session expires, API access stops.

OAuth 2.0 Authorization Code with PKCE remains available as a fallback when an org does not permit its browser session to access APIs:

1. Load the extension, open **Settings**, and copy the displayed callback URL. It has the form `https://<extension-id>.chromiumapp.org/`.
2. In Salesforce Setup, create an External Client App (preferred) or Connected App and enable OAuth.
3. Add that exact callback URL.
4. Add only **Manage user data via APIs (`api`)** and **Perform requests at any time (`refresh_token`, `offline_access`)**.
5. Require PKCE. Disable requirements for a client secret in the web-server and refresh-token flows because a browser extension is a public client and cannot protect a bundled secret.
6. Set the app's permitted-user policy appropriate for your organization, assign access where required, save, and allow several minutes for propagation.
7. Copy the Consumer Key (Client ID), never the Consumer Secret, into the extension's Settings page.

Auto-connect uses the launching Salesforce tab by default and can be disabled in Settings. OAuth fallback may require consent, MFA, login, or administrator approval.

For an unpacked build, keep the extension directory stable because Chrome may assign a different ID after reinstalling it, changing the callback URL. The published Web Store build has a stable ID. Each Salesforce org may need its own app/client ID unless your Salesforce packaging and policy arrangement makes one app available across orgs.

## Permissions

- `sidePanel`: lets the same workspace remain available through Chrome's side-panel menu; the toolbar action opens a dedicated window.
- `storage`: stores preferences, per-org metadata cache, test evidence, and optionally a refresh token when “Stay connected” is enabled.
- `identity`: completes the OAuth redirect through `chrome.identity.launchWebAuthFlow`.
- `cookies`: reads Salesforce `sid` cookies from the launching tab's cookie store for validated session authentication.
- `tabs`: keeps the connection pinned to the launching Salesforce tab and detects org changes.
- `activeTab`: reads only the active tab URL to recognize Salesforce page context; no content script or page DOM scraping is used.
- Salesforce host permissions: call supported REST/Tooling and OAuth endpoints on Salesforce domains. Credentials are never sent to another host.

Records are created, updated, or deleted only when the user saves a form or confirms a delete (Settings can turn record changes off entirely). SOQL, metadata, access, and log tools are read-only, and metadata is never changed. The form tester's optional screenshot capture is initiated explicitly by the user. No Salesforce data is sent to third-party services.

## What's in the workspace

- **Home** — the org and page you're on (with one-click Record details / Object details), "Jump back in" to recent tools, **Your workspace** (saved objects, records, and queries for this org), Setup and Object Manager shortcuts, and an org & user summary with details on demand.
- **Record management** — create, edit, and delete records from **Record details** (Edit / New / Delete), from a related list (New prefilled with the parent), from Record search (after picking an object), and from Objects & fields. Forms show only the fields you may set, validate required fields, lengths, numbers, emails, lookups, and dependent picklists before saving, map Salesforce errors to the right field without losing edits, detect concurrent changes (`If-Unmodified-Since`), and keep unsaved drafts if your session expires. Deletes need confirmation (typing DELETE in production) and refresh search, recent, related, and saved lists.
- **Record details** — every field you can read, grouped into collapsible sections from your assigned page layout (fields not on the layout appear under "Other fields"; objects without layout access fall back to logical groups). The header shows compact-layout highlights plus Edit, New, Open in Salesforce, and Delete. Values are formatted by type (currency with the record/org currency, percentages, dates, checkboxes, picklist labels, addresses, phone/email/URL links, long and rich text as plain text) and lookups open the related record. Includes field search, Hide empty fields, and Expand/Collapse all.
- **Users** — a searchable, paginated list (25 per page) with status, profile, user type, and sort filters, and a user page showing details, profile, permission set groups, permission sets, permission set licenses, key system permissions (with the assignment that grants each), and public group/queue memberships. It's labeled as **assigned** access; "Check this user's access" opens the access explainer for specific object/field/record questions.
- **Connection screen** — when no org is connected it shows a live checklist (Salesforce tab → org → session), the other Salesforce tabs you have open ("Use this tab"), orgs you've used ("Open"), and specific help for login pages, expired sessions, API access denied, and connection failures.
- **Themes** — System, Light, Dark, and High contrast modes; accent from the org's badge color or one of seven presets, with a live preview and Reset to default. Accent tokens (hover, pressed, subtle, focus) are generated to meet WCAG contrast (4.5:1, or 7:1 in High contrast), and accents too close to red are shifted so destructive actions stay distinct.
- **Records** — **Record search** (paste an ID, search by name/number/email with SOSL, optionally within one object, or pick from Recently viewed) and **Record details** with Details / Related / All fields tabs.
- **Access**, **Flows & Forms**, **Development** (read-only SOQL with sortable columns, CSV export, and saved queries), **Metadata**, and **Settings** (org names/colors edited in a modal; OAuth fallback under Advanced).
- Consistent UI patterns: breadcrumb headings with a Back button, toasts with Undo, validated modals that ask before discarding unsaved changes, keyboard-accessible navigation and comboboxes, and layouts that adapt from a narrow window (bottom nav) to a wide one (sidebar).

## Commands

- `npm run check` — typecheck, lint, tests, and production build
- `npm run watch` — rebuild during development
- `npm run package` — create a Web Store ZIP under `release/`
- `npm run preview` — build, then serve a dev preview at http://localhost:5174 that runs the real bundle against a fake Chrome API and a mock Salesforce org (`dev/preview/`). Options: `?page=record|home|none`, `?connect=fail`. The preview is never shipped.

## Current limitations

- Access results distinguish object/field permissions from record-level access; sharing and runtime context can make record conclusions uncertain.
- Dependency results use Salesforce's beta `MetadataComponentDependency` Tooling API. Standard components, dynamic Apex/SOQL, reports, managed-package internals, and other references may be absent; queries cap at 2,000 rows.
- Metadata and records are limited to what the connected Salesforce user can access through enabled APIs.
- Error explanations are local, rule-based heuristics and do not call an AI service.
- Record search uses SOSL, so brand-new records can take a few minutes to become searchable, and objects that aren't searchable must be queried in the SOQL workspace. Without an object filter it searches Accounts, Contacts, Leads, Opportunities, Cases, and Users.
- Record management uses the REST sObject API as the connected user. Object permissions and field-level security come from `describe` (cached per org for the metadata cache lifetime — use Refresh in Objects & fields or clear the cache after permission changes); record-level edit/delete access is checked live with `UserRecordAccess`. Salesforce always enforces access on save, so a stale cache can only lead to a clear error, never an unauthorized change.
- Record-type-specific picklist values, page-layout required fields, and lookup filters aren't evaluated before saving (they need the UI API); Salesforce checks them on save and the error appears on the form. Rich text, address/location compound fields (edit their component fields), files, and encrypted fields aren't editable in the form.
- Deleting uses the REST API and moves the record to the Recycle Bin; restoring it is done in Salesforce. Concurrent-change detection uses `If-Unmodified-Since` on `LastModifiedDate` (one-second precision).
- Page layouts come from `describe/layouts` for the record's record type, as assigned to the connected user. Objects without layouts (or users who can't read them) get metadata-based groups; related lists and custom buttons from the layout aren't shown.
- Users lists only the users Salesforce shares with the connected user. SOQL `OFFSET` limits paging to the first 2,000 matches (narrow filters to reach others). Permission set assignments, licenses, and group membership need "View Setup and Configuration" (or similar); sections the user can't read show an explanation instead. Group membership shows direct memberships only (not via roles, territories, or nested groups).
- "Recently viewed" comes from Salesforce's `RecentlyViewed` object and only includes records opened in the Salesforce UI.
- Saved items, test sessions, and history are stored in this Chrome profile only; they don't sync across browsers or users.
- "Capture tab" needs Chrome's activeTab grant, which Chrome gives only after you open the workspace from its toolbar icon or shortcut; otherwise paste or upload a screenshot.

See [PRIVACY.md](PRIVACY.md) and [docs/WEB_STORE_CHECKLIST.md](docs/WEB_STORE_CHECKLIST.md) before publishing.
