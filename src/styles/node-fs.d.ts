/*
 * `tsconfig.app.json` pins `types` to `vitest/globals` + `vite/client`, so
 * Node's own typings are not in scope. `theme.test.ts` has to read the three
 * stylesheets from disk — Vitest stubs every CSS import to an empty string,
 * `?raw` and `import.meta.glob` included — and that needs exactly one function.
 */
declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string
}
