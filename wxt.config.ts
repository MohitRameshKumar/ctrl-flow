import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    // Pins a stable extension ID across every machine. Regenerate with scripts/gen-key.sh.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3yRH6SsNsNkjn1QHq66nHRg88YYzVlwSBfif9rXP+VmAVrF+yIqcwkX1M5915isHvuElevmP/HIcSdgEDC+8CqxnJp4pDxO4OS6JmAaLey1Ffg/6WfJP5qtzRaK+kxX9/Xo3/EjGcmMy5HY0ivI+5gqlghMTslkQCpNQEQ9C6lK8zfhiygicteSxpPNts3Qn4pfXGWlskKwyAyYhIchyjxnXvN/NmQySSCGH4ljUg8Ux0ukvGO7rmDq7gIPTAjzPFeanHKn8te7sSC97crMaxN59VoHb48AEmVPU+4gbinL8arrFcunRT+TSsIEhObDCL+ZWRpXnFFfA++PrOCPzoQIDAQAB',
    // Toolbar button. Required for the recording/paused badge (UI-5) and for click-icon-opens-panel.
    action: { default_title: 'Cadence' },
    // Leader key. `Ctrl` becomes ⌘ on macOS (Ctrl+Alt combos are not allowed by Chrome).
    commands: {
      'leader-key': {
        suggested_key: { default: 'Ctrl+Shift+Space', mac: 'Command+Shift+Space' },
        description: 'Cadence: open the leader-key menu',
      },
    },
    permissions: [
      'tabs',
      'webNavigation',
      'storage',
      'unlimitedStorage',
      'alarms',
      'notifications',
      'tabGroups',
      'identity',
    ],
    host_permissions: ['<all_urls>'],
    incognito: 'not_allowed',
    oauth2: {
      // TODO: paste OAuth client ID from Google Cloud Console (must be registered against this
      // extension's ID, which is derived from the `key` above). Until set, GoogleCalendarSource
      // falls back to the demo calendar automatically.
      client_id: 'TODO-paste-oauth-client-id.apps.googleusercontent.com',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    },
  },
});
