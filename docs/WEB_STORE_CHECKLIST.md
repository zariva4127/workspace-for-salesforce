# Chrome Web Store publishing checklist

## Release

- Run `npm ci`, `npm run check`, and `npm run package` from a clean checkout.
- Install `dist/` unpacked and test sign-in, sign-out, token refresh, active-tab navigation, each tool, light/dark themes, keyboard navigation, exports, and error states in production and sandbox orgs.
- Upload `release/salesforce-workspace-<version>.zip`; do not upload source maps, secrets, test data, or Salesforce exports.
- Increment the version for every submitted update and retain the reviewed source matching each ZIP.

## Listing and policy

- Use a concise single-purpose description centered on Salesforce troubleshooting and testing.
- Provide 1280×800 or 640×400 screenshots without real customer, user, record, token, or org data.
- Supply the hosted privacy-policy URL and support contact. Complete the data-use disclosure consistently with `PRIVACY.md`.
- Explain each permission using the rationale in `README.md`. Verify the requested permissions remain the narrowest practical set.
- Declare that no remote code is used and that all executable JavaScript is included in the package.
- Do not claim complete access or dependency analysis; preserve the limitations disclosed in the UI.
- Confirm Salesforce branding, naming, and trademark usage comply with Salesforce guidelines; state that the product is independent if required.

## OAuth production readiness

- Register the callback containing the final Chrome Web Store extension ID in the Salesforce External Client App/Connected App.
- Use Authorization Code + PKCE, no client secret, and only `api` plus `refresh_token/offline_access` scopes.
- Review the permitted-user policy and assignment model with the Salesforce administrator.
- Test revocation, expired sessions, denied consent, insufficient API permissions, disabled API access, and an incorrect callback URL.
- Never paste a Consumer Secret, access token, refresh token, Salesforce export, or customer screenshot into listing assets or logs.
