import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// The broadcaster is a standalone sibling of moqtail/ (NOT part of the moqtail npm
// workspace), so `moqtail` and its transitive `mp4box` dep are not resolvable from
// broadcaster/node_modules at runtime. tsconfig `paths` fixes type resolution for
// `tsc`; these aliases do the equivalent for vitest's runtime module resolution,
// pointing at the built ESM artifacts (.mjs) rather than the .d.mts typings.
// Keep these in sync with the `paths` block in tsconfig.json (task 1.2).
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
      { find: 'mp4box', replacement: r('../moqtail/node_modules/mp4box/dist/mp4box.all.mjs') },
    ],
  },
})
