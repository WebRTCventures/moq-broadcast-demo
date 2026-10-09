# moq-broadcast-demo

A low-latency 1→N live broadcast built on [MOQtail](https://github.com/moqtail/moqtail)
(Media over QUIC Transport). The demo accompanies the "How does MoQ work?" post: it shows the
protocol-level decisions behind a real MoQ app — track/group/object mapping, SUBSCRIBE vs FETCH,
join-late viewers, and quality switching.

## Dev environment (Nix flake + direnv)

This repo ships a `flake.nix` + `.envrc` so the toolchain loads automatically on `cd`.

### What the dev shell provides
- **Rust** (`rustup`) — to build/run the MOQtail relay (`cargo run -p relay ...`). Set a toolchain
  once with `rustup default stable`, or let a `rust-toolchain.toml` pin it.
- **Node.js 22 + npm** — for `moqtail-ts` and the broadcaster/viewer app code. (Node 20 is EOL and
  flagged insecure in nixpkgs, so we pin 22.)
- **mkcert + nss.tools (certutil)** — the local dev certificate path. WebTransport rides QUIC, which
  is **always TLS even on localhost** (no `getUserMedia`-style insecure-localhost bypass). `mkcert`
  installs a locally-trusted CA so the browser accepts the relay's cert — no 14-day limit and no
  `serverCertificateHashes` fingerprint pinning needed.
- **docker-client + docker-compose** — optional, to run the relay as a container
  (`ghcr.io/moqtail/relay`) instead of building it from source.
- **openssl / pkg-config** — native build deps linked by the QUIC/TLS Rust crates.
- **just, git, jq** — task runner (MOQtail/moq.dev use justfiles) and utilities.

### Setup
```bash
# One time: install direnv + nix-direnv, then in this folder:
direnv allow

# One time inside the shell:
rustup default stable   # install a Rust toolchain
mkcert -install         # trust a local CA for the browser
```

Without direnv, enter the shell manually:
```bash
nix develop
```

## Prerequisite: clone and build MOQtail (required)

The broadcaster and viewer are standalone siblings of MOQtail, not part of its npm workspace. They
import the built draft-16 `moqtail-ts` library (and one helper, `cmaf-muxer.ts`) directly from a
local clone at `./moqtail/`. **The apps will not type-check or run until MOQtail is cloned here and
built.** The clone is git-ignored (it is its own repository) — it is a build dependency, not part of
this repo.

```bash
# From this repo root, inside the dev shell:
git clone https://github.com/moqtail/moqtail.git moqtail
cd moqtail && git checkout c2ff725   # pinned draft-16 commit this demo was built against
npm install && npm run build && cargo build -p relay && cd ..
```

The clone is pinned to commit `c2ff725` (the `draft-16` branch at build time) so the demo stays
reproducible even as the branch moves. draft-16 also lines up with Cloudflare's MoQ relay
(draft-14/16), so "develop locally, deploy to a CDN" is plausible on matching drafts.

## Run the demo (three terminals)

```bash
# 1. Relay — WebTransport (https) + raw QUIC (moqt) on one UDP port
cd moqtail && cargo run -p relay -- --port 4433 \
  --cert-file apps/relay/cert/cert.pem --key-file apps/relay/cert/key.pem

# 2. Broadcaster dev server  → http://localhost:5174/
cd broadcaster && npm install && npm run dev

# 3. Viewer dev server       → http://localhost:5175/
cd viewer && npm install && npm run dev
```

Open the broadcaster, click **Go Live** (grant camera), then open the viewer and connect to the same
namespace. A second viewer tab on the same namespace demonstrates the relay's 1→N fan-out.

### Dev cert (one time)
The relay reuses an mkcert-issued cert at `moqtail/apps/relay/cert/`. If the browser rejects it,
enable `chrome://flags/#webtransport-developer-mode`, run `mkcert -install`, and fully restart the
browser. (WebTransport rides QUIC, which is always TLS — there is no insecure-localhost bypass.)

## Tests

Each app has its own suite (TypeScript, `vitest` + `fast-check`):

```bash
cd broadcaster && npm run test && npm run typecheck
cd viewer      && npm run test && npm run typecheck
```

The viewer's quality-switch policy is property-tested (`viewer/quality.test.ts`); the orchestrators'
end-to-end behavior (join-late, group-boundary switching, fan-out) is verified manually against the
running relay.

## Notes
- Nix provides the toolchain only; it does not pin the MOQtail source. MOQtail is cloned/built as an
  application dependency, matching how a real engagement would consume it.
- This is a learning/demonstration demo. It takes named shortcuts for clarity — a single shared codec
  across the quality ladder, three fixed quality levels (no adaptive bitrate), and glass-to-glass
  latency measured via a wall-clock capture-timestamp header that assumes broadcaster and viewer
  share a clock. A production build adds adaptive bitrate, a packaging/codec negotiation path, and a
  CDN relay in place of the local one.
