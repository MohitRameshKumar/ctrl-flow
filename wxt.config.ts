import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    // Pins a stable extension ID across every machine. Regenerate with scripts/gen-key.sh.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3yRH6SsNsNkjn1QHq66nHRg88YYzVlwSBfif9rXP+VmAVrF+yIqcwkX1M5915isHvuElevmP/HIcSdgEDC+8CqxnJp4pDxO4OS6JmAaLey1Ffg/6WfJP5qtzRaK+kxX9/Xo3/EjGcmMy5HY0ivI+5gqlghMTslkQCpNQEQ9C6lK8zfhiygicteSxpPNts3Qn4pfXGWlskKwyAyYhIchyjxnXvN/NmQySSCGH4ljUg8Ux0ukvGO7rmDq7gIPTAjzPFeanHKn8te7sSC97crMaxN59VoHb48AEmVPU+4gbinL8arrFcunRT+TSsIEhObDCL+ZWRpXnFFfA++PrOCPzoQIDAQAB',
    permissions: [
      'tabs',
      'webNavigation',
      'storage',
      'unlimitedStorage',
      'alarms',
      'notifications',
      'tabGroups',
      'identity',
      // Click replay injects a self-contained click function into the page.
      'scripting',
      // chrome.sidePanel.open() needs this declared; WXT may add it too, duplicates are fine.
      'sidePanel',
    ],
    commands: {
      // Ctrl+Shift+K/Y are free in Chrome (it reserves Shift+T/N/W/Q/I/J/A/B/M/O/Delete), and
      // Ctrl+K belongs to the omnibox. Chrome silently leaves the command unbound if another
      // extension already holds this, so the Macros tab shows the live binding.
      'open-macro-palette': {
        suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
        description: 'Cadence: open the macro palette',
      },
    },
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
