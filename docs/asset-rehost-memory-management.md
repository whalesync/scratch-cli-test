# Asset Rehost: Memory Management Approaches

The rehost job downloads files from source URLs and re-uploads them to GCS. Each file is fully buffered in memory during transfer. With 40K+ assets, memory management matters.

## Current Behavior

`BATCH_SIZE = 5` with full `arraybuffer` downloads. Safe but slow (~130 assets/min).

## Approaches

### 1. Byte-budget batching (implemented)

Instead of a fixed count, limit concurrency by total in-flight bytes. Use the `size` field from the Asset table (populated during pull) to estimate memory before starting each download.

- **Target budget:** 200MB of in-flight downloads at any time
- **Behavior:** Launch up to N concurrent downloads as long as their estimated total size stays under the budget. When a download completes, free its budget and start the next.
- **Fallback:** Assets without a known size use a conservative estimate (e.g. 5MB).
- **Pros:** Simple, no architectural changes. Small images get high concurrency, large images get low concurrency.
- **Cons:** Still buffers entire files. Actual memory may exceed budget if size estimates are wrong.

### 2. Streaming transfers

Pipe the HTTP download response directly into the GCS upload stream without buffering the whole file. Each concurrent transfer uses only a small stream buffer (~64KB).

- **Requires:** Changing `axios.get` from `responseType: 'arraybuffer'` to `responseType: 'stream'`, and updating `ObjectStorageService.saveObject` to accept a readable stream.
- **Pros:** Near-zero memory per transfer regardless of file size. Could safely run 100+ concurrent transfers.
- **Cons:** Can't compute `contentHash` before upload (would need a pass-through hash stream). More complex error handling (partial uploads on network failure).

### 3. Hybrid: buffer small, stream large

Buffer files under a threshold (e.g. 1MB) for simplicity, stream anything larger.

- **Pros:** Best of both worlds — simple fast path for small files, memory-safe for large files.
- **Cons:** Two code paths to maintain.
