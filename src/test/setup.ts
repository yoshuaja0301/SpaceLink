// Global test setup: jsdom shims the browser APIs the app touches.
//
// The server suites run under the node environment, where there is no window at
// all — they simply have nothing to shim.
if (typeof window !== 'undefined' && !('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
