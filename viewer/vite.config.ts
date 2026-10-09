import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Dev-server config for the viewer page (quality picker + <video>, task 9).
//
// The viewer is a standalone sibling of moqtail/ (NOT part of the moqtail npm
// workspace), so `moqtail` is not resolvable from viewer/node_modules at runtime.
// These aliases point Vite at the built ESM artifacts (.mjs), mirroring the runtime
// aliases in vitest.config.ts and the type-resolution `paths` in tsconfig.json. The
// viewer imports NO `mp4box`/`CMAFMuxer` (it consumes objects, it does not mux), so
// those aliases are intentionally absent. Keep all three in sync.
//
// Port 5175 avoids a clash with the stock client-js player (5173) and the
// broadcaster harness (5174).
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  server: {
    port: 5175,
    open: false,
  },
  resolve: {
    // Order matters: longer/subpath specifiers must precede the bare `moqtail`.
    alias: [
      { find: 'moqtail/client', replacement: r('../moqtail/libs/moqtail-ts/dist/client.mjs') },
      { find: 'moqtail/model', replacement: r('../moqtail/libs/moqtail-ts/dist/model.mjs') },
      { find: 'moqtail/util', replacement: r('../moqtail/libs/moqtail-ts/dist/util.mjs') },
      { find: /^moqtail$/, replacement: r('../moqtail/libs/moqtail-ts/dist/index.mjs') },
    ],
  },
})
