# Build Instructions for scratch-cli

This document explains how to build the `scratchmd` CLI for different platforms.

## Prerequisites

- **Go 1.21+** installed (check with `go version`)
- Clone the repository

## Quick Build (Current Platform)

```bash
# Build for your current OS/architecture
go build -o scratchmd ./cmd/scratchmd

# Run it
./scratchmd --help
```

## Build with Version Info

To embed version information into the binary:

```bash
VERSION=0.1.0
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SCRATCH_API_SERVER_URL="https://api.scratch.md"

go build -ldflags "-X 'github.com/whalesync/scratch-cli/internal/cmd.version=${VERSION}' \
                   -X 'github.com/whalesync/scratch-cli/internal/cmd.commit=${COMMIT}' \
                   -X 'github.com/whalesync/scratch-cli/internal/cmd.buildDate=${BUILD_DATE}' \
                   -X 'github.com/whalesync/scratch-cli/internal/api.DefaultScratchServerURL=${SCRATCH_API_SERVER_URL}'" \
         -o scratchmd ./cmd/scratchmd
```

## Cross-Platform Builds

Build for different operating systems and architectures:

### macOS (Apple Silicon)

```bash
GOOS=darwin GOARCH=arm64 go build -o scratchmd-darwin-arm64 ./cmd/scratchmd
```

### macOS (Intel)

```bash
GOOS=darwin GOARCH=amd64 go build -o scratchmd-darwin-amd64 ./cmd/scratchmd
```

### Linux (x86_64)

```bash
GOOS=linux GOARCH=amd64 go build -o scratchmd-linux-amd64 ./cmd/scratchmd
```

### Linux (ARM64)

```bash
GOOS=linux GOARCH=arm64 go build -o scratchmd-linux-arm64 ./cmd/scratchmd
```

### Windows (x86_64)

```bash
GOOS=windows GOARCH=amd64 go build -o scratchmd-windows-amd64.exe ./cmd/scratchmd
```

## Build All Platforms Script

Create a release build for all major platforms:

```bash
#!/bin/bash
set -e

VERSION=${1:-"dev"}
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SCRATCH_API_SERVER_URL="https://api.scratch.md"

LDFLAGS="-X 'github.com/whalesync/scratch-cli/internal/cmd.version=${VERSION}' \
         -X 'github.com/whalesync/scratch-cli/internal/cmd.commit=${COMMIT}' \
         -X 'github.com/whalesync/scratch-cli/internal/cmd.buildDate=${BUILD_DATE}' \
         -X 'github.com/whalesync/scratch-cli/internal/api.DefaultScratchServerURL=${SCRATCH_API_SERVER_URL}'" \


mkdir -p dist

# macOS
GOOS=darwin GOARCH=arm64 go build -ldflags "$LDFLAGS" -o dist/scratchmd-darwin-arm64 ./cmd/scratchmd
GOOS=darwin GOARCH=amd64 go build -ldflags "$LDFLAGS" -o dist/scratchmd-darwin-amd64 ./cmd/scratchmd

# Linux
GOOS=linux GOARCH=amd64 go build -ldflags "$LDFLAGS" -o dist/scratchmd-linux-amd64 ./cmd/scratchmd
GOOS=linux GOARCH=arm64 go build -ldflags "$LDFLAGS" -o dist/scratchmd-linux-arm64 ./cmd/scratchmd

# Windows
GOOS=windows GOARCH=amd64 go build -ldflags "$LDFLAGS" -o dist/scratchmd-windows-amd64.exe ./cmd/scratchmd

echo "Build complete! Binaries in dist/"
ls -la dist/
```

## Development Build

For faster development iteration (skips optimizations):

```bash
go build -gcflags="all=-N -l" -o scratchmd ./cmd/scratchmd
```

## Install Globally

To install the binary to your `$GOPATH/bin`:

```bash
go install ./cmd/scratchmd
```

Make sure `$GOPATH/bin` is in your `$PATH`.

## GoReleaser Builds

The project includes a GoReleaser configuration (`.goreleaser.yaml`) for automated builds. This creates both **production** and **test** builds with different server URLs baked in.

### Prerequisites

Install GoReleaser:

```bash
# macOS
brew install goreleaser

# or via Go
go install github.com/goreleaser/goreleaser/v2@latest
```

### Local Snapshot Build (No Release)

Build all artifacts locally without publishing:

```bash
goreleaser release --snapshot --clean
```

This creates binaries in `dist/` for both environments:

- **Production**: `scratchmd_<version>_<os>_<arch>.tar.gz` → points to `https://api.scratch.md`
- **Test**: `scratchmd-test_<version>_<os>_<arch>.tar.gz` → points to `https://test-api.scratch.md`

### Build Only Production

```bash
goreleaser build --snapshot --clean --id scratchmd-production
```

### Build Only Test

```bash
goreleaser build --snapshot --clean --id scratchmd-test
```

### Full Release (GitHub)

To create a tagged release on GitHub:

```bash
# Tag the release
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0

# Create the release (requires GITHUB_TOKEN)
export GITHUB_TOKEN="your-github-token"
goreleaser release --clean
```

This will:

1. Build binaries for all platforms (linux, darwin, windows × amd64, arm64)
2. Create archives with checksums
3. Publish a GitHub release with all artifacts

### Output Structure

After running `goreleaser release --snapshot --clean`:

```
dist/
├── scratchmd_0.1.0-next_darwin_amd64.tar.gz      # Production macOS Intel
├── scratchmd_0.1.0-next_darwin_arm64.tar.gz      # Production macOS Apple Silicon
├── scratchmd_0.1.0-next_linux_amd64.tar.gz       # Production Linux x86_64
├── scratchmd_0.1.0-next_linux_arm64.tar.gz       # Production Linux ARM64
├── scratchmd_0.1.0-next_windows_amd64.zip        # Production Windows
├── scratchmd-test_0.1.0-next_darwin_amd64.tar.gz # Test macOS Intel
├── scratchmd-test_0.1.0-next_darwin_arm64.tar.gz # Test macOS Apple Silicon
├── scratchmd-test_0.1.0-next_linux_amd64.tar.gz  # Test Linux x86_64
├── scratchmd-test_0.1.0-next_linux_arm64.tar.gz  # Test Linux ARM64
├── scratchmd-test_0.1.0-next_windows_amd64.zip   # Test Windows
└── checksums.txt
```

## Verify Build

After building, verify the binary works:

```bash
./scratchmd --version
./scratchmd --help
```
