# Package the prebuilt scratch-git-2 Rust binary into a slim runner image.
# The binary is built by the `build and test scratch-git` CI job (rust:slim-bookworm,
# glibc-compatible with debian:bookworm-slim) and passed in as a GitLab artifact.
# Run from the repository root:
#   docker build -t spinner-scratch-git -f scratch-git-2/Dockerfile .

FROM debian:bookworm-slim AS runner
RUN apt-get update && apt-get install -y dumb-init git git-daemon-sysvinit && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Binary is prebuilt by CI (or locally via `cargo build --release --bin scratch-git-2`)
# and copied directly from the repo's target dir.
COPY scratch-git-2/target/release/scratch-git-2 ./scratch-git-api

# Create the default repos directories
RUN mkdir -p /data/repos /data/repos-v2

# Build version label
ARG BUILD_VERSION=0.0.0-local
ENV BUILD_VERSION=${BUILD_VERSION}

# Environment variables
ENV PORT=3100
ENV GIT_BACKEND_PORT=3101
ENV GIT_REPOS_DIR=/data/repos
ENV GIT_REPOS_V2_DIR=/data/repos-v2
ENV NODE_ENV=production
ENV RUST_LOG=info

EXPOSE 3100 3101

# Start the single Rust binary taking advantage of dumb-init for PID 1 signaling
CMD ["dumb-init", "./scratch-git-api"]
