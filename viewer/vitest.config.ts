import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// The viewer is a standalone sibling of moqtail/ (NOT part of the moqtail npm
// workspace), so `moqtail` is not resolvable from viewer/node_modules at runtime.
// tsconfig `paths` fixes type resolution for `tsc`; these aliases do the equivalent
// for vitest's runtime module resolution, pointing at the built ESM artifacts
// (.mjs) rather than the .d.mts typings. The viewer imports NO `mp4box`/`CMAFMuxer`
// (it consumes objects, it does not mux), so those aliases are intentionally absent.
// Keep these in sync with the `paths` block in tsconfig.json and vite.config.ts.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
  },
  resolve: {
    // Array form so each `find` is matched as an exact/prefix specifier.
    // Order matters: longer/subpath specifiers must precede the bare `moqtail`.
    alias: [
      { find: 'moqtail/client', replacement: r('../moqtail/libs/moqtail-ts/dist/client.mjs') },
      { find: 'moqtail/model', replacement: r('../moqtail/libs/moqtail-ts/dist/model.mjs') },
      { find: 'moqtail/util', replacement: r('../moqtail/libs/moqtail-ts/dist/util.mjs') },
      { find: /^moqtail$/, replacement: r('../moqtail/libs/moqtail-ts/dist/index.mjs') },
    ],
  },
})
