import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// @ts-expect-error -- plain JS, so the same module can be unit tested directly.
import { precachePlugin } from './build/precache.mjs'

export default defineConfig({
  plugins: [react(), precachePlugin()],
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'server/**/*.test.mjs',
      'macos/**/*.test.mjs',
      'build/**/*.test.mjs',
    ],
  },
})
