# Build the Rust API and the integrated git-http-backend
# Run from the repository root: docker build -t spinner-scratch-git -f scratch-git-2/Dockerfile .

# --- Stage 1: Rust Builder ---
FROM rust:slim-bookworm AS rust-builder
WORKDIR /app
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY scratch-git-2/Cargo.toml scratch-git-2/Cargo.lock ./
# Create a dummy main.rs to build dependencies first (for better caching)
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY scratch-git-2/src ./src
# Touch main.rs to ensure Cargo detects it's newer than the dummy main compilation
RUN touch src/main.rs
RUN cargo build --release

# --- Stage 2: Runner ---
FROM debian:bookworm-slim AS runner
RUN apt-get update && apt-get install -y dumb-init git git-daemon-sysvinit && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Copy Rust API
COPY --from=rust-builder /app/target/release/scratch-git-2 ./scratch-git-api

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
