{
  description = "MoQ broadcast demo — dev shell for building a 1→N live broadcast on MOQtail (Rust relay + TypeScript client)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          # Toolchain to build + run the demo:
          #   - MOQtail relay (Rust): `cargo run -p relay ...`
          #   - broadcaster + viewer (TypeScript on moqtail-ts): Node 22 + npm
          #   - local dev cert for the WebTransport/QUIC TLS handshake (mkcert; openssl fallback)
          #   - optional containerized relay (ghcr.io/moqtail/relay) via docker/compose client
          packages = with pkgs; [
            # --- Rust (for the MOQtail relay; rustup lets the repo pin via rust-toolchain.toml) ---
            rustup
            pkg-config          # native build deps for QUIC/TLS crates
            openssl             # linked by QUIC/TLS crates; also a cert fallback

            # --- Node / TypeScript (moqtail-ts, broadcaster, viewer) ---
            nodejs_22           # Node 20 is EOL / flagged insecure in nixpkgs; pin 22 (bundles npm)

            # --- Local dev certificate (the verified cert path) ---
            mkcert              # installs a locally-trusted CA so the browser accepts the relay cert
            nss.tools           # certutil — needed by mkcert to trust certs in Chrome/Firefox on Linux

            # --- Containerized relay (optional) + utilities ---
            docker-client       # talk to the Docker daemon for ghcr.io/moqtail/relay
            docker-compose
            git
            jq
            just                # task runner (moqtail/moq.dev repos use justfiles)
          ];

          shellHook = ''
            echo "moq-broadcast-demo dev shell"
            echo "  rust : $(rustc --version 2>/dev/null || echo 'run: rustup default stable')"
            echo "  node : $(node --version)"
            echo "  mkcert: $(mkcert -version 2>/dev/null || echo present)"
            echo ""
            echo "First run:"
            echo "  rustup default stable          # install a Rust toolchain if none is set"
            echo "  mkcert -install                # trust a local CA (one time)"
            echo ""
            echo "WebTransport rides QUIC, which is always TLS — even on localhost."
            echo "Use mkcert for a locally-trusted relay cert (no 14-day limit, no fingerprint pinning)."

            # OpenSSL headers for QUIC/TLS crates that build against the system lib.
            export OPENSSL_DIR="${pkgs.openssl.dev}"
            export OPENSSL_LIB_DIR="${pkgs.openssl.out}/lib"
            export PKG_CONFIG_PATH="${pkgs.openssl.dev}/lib/pkgconfig:$PKG_CONFIG_PATH"
          '';
        };
      });
}
