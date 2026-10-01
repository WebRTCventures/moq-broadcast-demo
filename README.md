# moq-broadcast-demo

A low-latency 1→N live broadcast built on [MOQtail](https://github.com/moqtail/moqtail)
(Media over QUIC Transport). The demo accompanies the "How does MoQ work?" post: it shows the
protocol-level decisions behind a real MoQ app — track/group/object mapping, SUBSCRIBE vs FETCH,
join-late viewers, and quality switching.

See the build plan at `../hector-posts/how-does-moq-work/demo.md`.

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

## Next steps (per the build plan)
1. Clone MOQtail (`draft-16` branch — the stable branch, and the draft Cloudflare's CDN supports),
   `npm install`, build.
2. Run the relay with an mkcert-issued cert; confirm the stock MOQtail player plays end-to-end.
3. Build the broadcaster (`broadcaster/`) and viewer (`viewer/`) — the two Kiro specs in the plan.

## Notes
- Nix does not pin the MOQtail source itself; it provides the toolchain. MOQtail is cloned/managed as
  application dependency (git + npm/cargo), matching how a real engagement would consume it.
- Pinning MOQtail at draft-16 keeps the demo reproducible and lines up with Cloudflare's relay
  (draft-14/16), so "develop locally, deploy to a CDN" is plausible on matching drafts.
