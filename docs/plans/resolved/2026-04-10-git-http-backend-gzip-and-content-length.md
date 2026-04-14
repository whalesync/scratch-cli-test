# Git HTTP backend: gzip decompression and Content-Length handling

**Date**: 2026-04-10
**Status**: Resolved

## Problem statement

Desktop app downloads (`scratchmd files download`) were failing with:

```
fatal: the remote end hung up unexpectedly
```

The error occurred during `git fetch` from the CLI to the scratch-git-2 service, proxied through the NestJS server. The failure was specific to repos with enough data to trigger git's request body compression, but produced no actionable error output — only `git http-backend exited with exit status: 1` with no stderr.

## Root cause

Two issues in the request pipeline between the CLI and `git http-backend`:

### 1. Missing Content-Length (NestJS proxy → scratch-git-2)

The NestJS git proxy (`CliWorkbookController.proxyToGitBackend`) streams the request body to scratch-git-2 using Node's `fetch()` with a `ReadableStream` body. Node's fetch implementation **strips the `Content-Length` header** when the body is a stream, since it cannot verify the declared length matches the stream output.

`git http-backend` is a CGI program that reads the `CONTENT_LENGTH` environment variable to determine how many bytes to consume from stdin. With an empty value, it reads zero bytes — `git-upload-pack` receives no "want" lines and exits immediately.

### 2. Gzip-compressed request body (git client → scratch-git-2)

Git clients compress `git-upload-pack` POST bodies with gzip when the payload exceeds a size threshold (controlled by `http.postBuffer`). The compressed body arrives with the correct `Content-Length` for the compressed size, but `git http-backend` expects raw pkt-line protocol data on stdin. Neither the NestJS proxy nor scratch-git-2 was decompressing the body before passing it to the CGI process.

## Key decisions

- **Buffer POST/PUT bodies in scratch-git-2** rather than streaming them. Git protocol request bodies are small (typically <10KB even decompressed), so buffering has negligible memory impact. This solves both the Content-Length and gzip issues in one place, keeping the fix close to `git http-backend` where it matters.

- **Detect gzip by magic bytes** (`1F 8B`) in addition to the `Content-Encoding` header. The header may be stripped by intermediate proxies, but the magic bytes are always present in gzip data.

- **Improved error handling for CGI failures** — detect when `git http-backend` exits without producing valid CGI headers and return a proper 500 with captured stdout/stderr, instead of an empty 200 that causes the client to see "remote end hung up."

## Changes

### scratch-git-2 (`src/service/routes/smart_http.rs`)

- POST/PUT request bodies are now buffered before spawning `git http-backend`
- Gzip-compressed bodies are detected and decompressed (using `flate2`)
- `CONTENT_LENGTH` is set from the actual (decompressed) body size, not the original header
- Added `flate2` crate dependency for gzip decompression
- CGI header parsing detects missing/malformed responses and returns 500 with diagnostics
- stderr is collected and logged alongside exit status on failure
- Non-success CGI `Status` headers are logged

### NestJS server (`server/src/cli/cli-workbook.controller.ts`)

- `Content-Length` header is forwarded to scratch-git-2 when present in the original request
- Response body streaming uses a while-loop with error handling instead of recursive `pump()`
- Stream errors are caught and logged with bytes-transferred count
- Empty response bodies are logged as warnings

## Request flow (after fix)

```
git client (CLI)
  │  POST git-upload-pack (may be gzip-compressed)
  ▼
NestJS proxy (proxyToGitBackend)
  │  Streams body + forwards Content-Length/Content-Encoding
  ▼
scratch-git-2 (git_backend handler)
  │  Buffers body → detects gzip → decompresses → sets CONTENT_LENGTH
  ▼
git http-backend (CGI)
  │  Reads CONTENT_LENGTH bytes from stdin → runs git-upload-pack
  ▼
Response streams back through the same chain
```
