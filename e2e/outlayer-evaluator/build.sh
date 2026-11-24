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
# Usage: ./build.sh [--check]
#   The wasm is written to target/outlayer-evaluator/reproducible/ at the
#   repository's root, where the e2e's `outlayer-evaluator` scenario reads it.
#   With --check, the build fails unless its hash is the one in wasm.sha256.
set -euo pipefail

check=false
case "${1:-}" in
  "") ;;
  --check) check=true ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

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

wasm="$out/outlayer-evaluator.wasm"
if command -v sha256sum >/dev/null; then
  hash=$(sha256sum "$wasm" | cut -d' ' -f1)
else
  hash=$(shasum -a 256 "$wasm" | cut -d' ' -f1)
fi
echo "$hash  $wasm"

if $check; then
  recorded=$(cat "$here/wasm.sha256")
  if [ "$hash" != "$recorded" ]; then
    echo "not the hash recorded in e2e/outlayer-evaluator/wasm.sha256: $recorded" >&2
    echo "If the program's sources changed on purpose, record the new hash there:" >&2
    echo "it is another program, with another evaluator account." >&2
    exit 1
  fi
fi
