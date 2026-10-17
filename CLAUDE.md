## Testing policy
- Do NOT run Playwright e2e tests (`npm run test:e2e`, `npm run test:e2e:live`) unless I explicitly ask. The human tests manually in Chrome.
- Do NOT write new Playwright e2e tests unless asked. Existing e2e files stay in the repo untouched.
- After any change, verify with only:
  1. `tsc` (app and proxy): must be clean
  2. the normal build: must succeed
  3. fast unit tests for the logic you changed (no browser)
  4. if `proxy/` changed: redeploy, then one curl per changed task checking status and response shape (never print the token)
- Always end with a numbered manual checklist for the human: what to click and what to expect.
- Keep reports short: what changed, what was verified, the checklist.
