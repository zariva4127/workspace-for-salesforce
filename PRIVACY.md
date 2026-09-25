# Privacy policy

Salesforce Workspace processes Salesforce information locally in the user's Chrome profile to provide the features the user invokes. It does not sell data, use data for advertising, or send Salesforce data to the developer or any third-party analytics or AI service.

The extension may store per-org display preferences, metadata cache entries, test steps and screenshots, and recent tool state. When launched from Salesforce, it reads that tab's Salesforce session cookie, validates its org and user through Salesforce APIs, and holds the credential only in protected Chrome session storage until Chrome closes. OAuth access tokens also use session storage. If the user explicitly enables **Stay connected** for OAuth, a refresh token is stored in Chrome extension local storage; access tokens are not persisted there. The extension never asks for or stores Salesforce passwords or client secrets. It changes Salesforce data only when the user saves a record form or confirms a delete, using the user's own permissions; unsaved form drafts are kept only in that window's session storage and are cleared when saved or discarded.

Data is exchanged only with the connected Salesforce org and, when OAuth fallback is used, Salesforce's login endpoint. Supported REST, Tooling, identity, and session-native endpoints validate and use the connection. Salesforce controls the source data and its retention. Local data remains until the user clears a cache, forgets an org, removes the extension, or clears the Chrome profile's extension data.

Users can disconnect to revoke the active Salesforce token and can use **Forget org** to remove that org's connection, settings, cached metadata, query history, and test sessions from extension storage. Exported reports are saved only where the user chooses.

The extension requests access to Salesforce domains, the active tab URL, Chrome identity flow, side panel, and extension storage solely for the functionality described above. It contains no remote executable code. GeoNames data is not used.

Before publication, replace this paragraph with the publisher's support contact and policy effective date, host this policy at a stable public HTTPS URL, and keep the hosted version consistent with the extension's behavior.
