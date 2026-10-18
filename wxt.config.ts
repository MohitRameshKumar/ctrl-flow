import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'ctrl-flow',
    short_name: 'ctrl-flow',
    description: 'ctrl-flow: finds the routines in your Chrome activity, groups tabs into projects and repeats them with one key. Everything stays on your device.',
    // Pins a stable extension ID across every machine. Regenerate with scripts/gen-key.sh.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3yRH6SsNsNkjn1QHq66nHRg88YYzVlwSBfif9rXP+VmAVrF+yIqcwkX1M5915isHvuElevmP/HIcSdgEDC+8CqxnJp4pDxO4OS6JmAaLey1Ffg/6WfJP5qtzRaK+kxX9/Xo3/EjGcmMy5HY0ivI+5gqlghMTslkQCpNQEQ9C6lK8zfhiygicteSxpPNts3Qn4pfXGWlskKwyAyYhIchyjxnXvN/NmQySSCGH4ljUg8Ux0ukvGO7rmDq7gIPTAjzPFeanHKn8te7sSC97crMaxN59VoHb48AEmVPU+4gbinL8arrFcunRT+TSsIEhObDCL+ZWRpXnFFfA++PrOCPzoQIDAQAB',
    // Toolbar button. Required for the recording/paused badge (UI-5) and for click-icon-opens-panel.
    action: { default_title: 'ctrl-flow' },
    // Leader key. `Ctrl` becomes ⌘ on macOS (Ctrl+Alt combos are not allowed by Chrome).
    commands: {
      'leader-key': {
        suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' },
        description: 'ctrl-flow: open the leader-key menu',
      },
      // No default binding: the palette is reachable via leader → / (search includes macros), and
      // the Macros tab shows "Set a shortcut" if the user wants a direct key.
      'open-macro-palette': {
        description: 'ctrl-flow: open the macro palette',
      },
      'run-macro-slot-1': { description: 'ctrl-flow: run macro slot 1' },
      'run-macro-slot-2': { description: 'ctrl-flow: run macro slot 2' },
      'run-macro-slot-3': { description: 'ctrl-flow: run macro slot 3' },
      'run-macro-slot-4': { description: 'ctrl-flow: run macro slot 4' },
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
      // Click replay injects a self-contained click function into the page.
      'scripting',
      // chrome.sidePanel.open() needs this declared; WXT may add it too, duplicates are fine.
      'sidePanel',
      // Find PDF: save the PDF it finds, and the notification's "Open" button.
      'downloads',
      'downloads.open',
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
