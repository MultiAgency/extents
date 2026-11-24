#!/usr/bin/env bash
#
# Builds the evaluator so that anyone gets the same bytes from the same source,
# and prints the sha256 of the wasm: the hash its key, and so its account, is
# bound to.
#
# The build runs in the official Rust image, named by the digest of its
# linux/amd64 manifest, with the repository at a fixed path, a fresh cargo
# home and a fresh target directory. A build on the host embeds the host's
# paths, and another architecture's compiler can give other bytes, so neither
# is a hash someone else can check.
#
# Usage: ./build.sh
#   The wasm is written to target/outlayer-evaluator/reproducible/ at the
#   repository's root, where the e2e's `outlayer-evaluator` scenario reads it.
set -euo pipefail

# rust:1.97.1-slim-bookworm, linux/amd64: the toolchain of rust-toolchain.toml.
IMAGE="rust@sha256:39f68a3e8e3ff425f8945ffa91128e60ff930d53e17fbb5214e95824bdd46f1b"

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/target/outlayer-evaluator/reproducible"
mkdir -p "$out"

docker run --rm --platform linux/amd64 \
  --volume "$root":/src:ro \
  --volume "$out":/out \
  --workdir /src/e2e/outlayer-evaluator \
  --env CARGO_TARGET_DIR=/build \
  "$IMAGE" sh -euc '
    rustup target add wasm32-wasip2 >/dev/null
    cargo build --release --locked
    cp /build/wasm32-wasip2/release/outlayer-evaluator.wasm /out/outlayer-evaluator.wasm
  '

if command -v sha256sum >/dev/null; then
  sha256sum "$out/outlayer-evaluator.wasm"
else
  shasum -a 256 "$out/outlayer-evaluator.wasm"
fi
