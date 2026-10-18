import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
export default defineConfig(({ command }) => ({
  main: {
    build: {
      externalizeDeps: { exclude: ['zod', 'diff'] },
      rollupOptions: { input: resolve('src/main/index.ts') },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: { minify: true },
    ...(command === 'serve' ? { html: { cspNonce: 'ensemble-development-style' } } : {}),
    plugins: [
      {
        name: 'ensemble-csp',
        transformIndexHtml: {
          order: 'pre',
          handler: (html) =>
            command === 'serve'
              ? html.replace(
                  "style-src 'self'",
                  "style-src 'self' 'nonce-ensemble-development-style'",
                )
              : html.replace(
                  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
                  "connect-src 'none'",
                ),
        },
      },
    ],
  },
}));
