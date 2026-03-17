#!/usr/bin/env bash
# Build the scratchmd binary (release mode).
set -euo pipefail

cargo build --release
echo "binary: $(pwd)/target/release/scratchmd"
