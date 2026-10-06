import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// Dev-server config for the manual end-to-end harness (Task 11).
//
// The broadcaster is a standalone sibling of moqtail/ (NOT part of the moqtail npm
// workspace), so `moqtail` and its transitive `mp4box` dep are not resolvable from
// broadcaster/node_modules at runtime. These aliases point Vite at the built ESM
// artifacts (.mjs), mirroring the runtime aliases already used by vitest.config.ts
// and the type-resolution `paths` in tsconfig.json. Keep all three in sync.
//
// The page is served over plain HTTP (Vite default). WebTransport to the relay is
// still TLS end-to-end because the *relay* terminates QUIC/TLS — the browser page
// origin does not need HTTPS for this, matching how moqtail/apps/client-js is
// served at http://localhost during Milestone 0.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  server: {
    port: 5174, // 5173 is used by the stock client-js player; avoid a clash
    open: false,
  },
  resolve: {
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
