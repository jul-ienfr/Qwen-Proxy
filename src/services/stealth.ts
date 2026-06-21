// CloakBrowser handles most stealth evasion at the C++ binary level:
// navigator.webdriver, client hints, plugins, chrome API, WebGL, canvas, audio,
// user-agent, headless dimensions, etc.
//
// This script only contains patches that CloakBrowser does NOT cover.

export function getStealthScript(_languages?: string[]): string {
  return `
    // Notification Permission query override
    try {
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: (typeof Notification !== 'undefined' ? Notification.permission : 'default'), onchange: null })
          : originalQuery(parameters);
    } catch(e) {}

    // Connection mock
    try {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          addEventListener: () => {},
          removeEventListener: () => {},
        }),
      });
    } catch(e) {}
  `;
}
