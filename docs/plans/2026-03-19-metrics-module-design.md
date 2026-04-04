# Metrics Module for Scratch Server

## Context

The Scratch server needs a metrics module to log metric values to Google Cloud Metrics via OpenTelemetry. The Terraform infrastructure for OTel sidecar collectors is already deployed (commit `a39969c4`), which sets `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and `USE_OPENTELEMETRY_METRICS=true` on CloudRun services. This module ports the architecture from the Whalesync/Bottlenose project, excluding all AWS/CloudWatch code and the specific metric enum values.

## File Structure

```
server/src/metrics/
├── metrics.module.ts                          # NestJS module with factory provider
├── types.ts                                   # CustomMetricDimension, CustomMetricUnit, CustomMetricDimensionValue
├── custom-metrics.ts                          # CustomMetric enum (empty/placeholder) + helper functions
├── custom-metrics-service.ts                  # Symbol-based interface definition
├── stub-metrics.service.ts                    # No-op implementation (tests)
├── dev-metrics.service.ts                     # Console logging implementation (dev)
├── opentelemetry/
│   ├── opentelemetry-metrics.service.ts       # OTel implementation (GCP production)
│   └── opentelemetry-metric-collector.ts      # OTel instrument wrapper
└── __tests__/
    └── opentelemetry-metric-collector.spec.ts # Unit tests
```

## Implementation Steps

### Step 1: Add OpenTelemetry dependencies

Add to `server/package.json`:

- `@opentelemetry/api`
- `@opentelemetry/sdk-metrics`
- `@opentelemetry/exporter-metrics-otlp-http`
- `@opentelemetry/exporter-prometheus`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`

### Step 2: Add config methods to ScratchConfigService

Add to `server/src/config/scratch-config.service.ts`:

- `getUseOpenTelemetryMetrics(): boolean` — reads `USE_OPENTELEMETRY_METRICS` env var (default `false`)
- `getRunningInCloud(): boolean` — expose existing `runningInCloudRun` field (already has `isRunningInCloudRun()` static method, add instance method)
- `getFriendlyServiceName(): string` — returns a service name string for OTel resource attributes (derive from `SERVICE_TYPE`)
- `getBuildVersion(): string` — reads `BUILD_VERSION` env var or returns `'local'`

### Step 3: Create types.ts

Port from Whalesync — identical enums:

- `CustomMetricDimension` enum (NO_DIMENSION, TABLE_NAME, CONNECTOR_TYPE, JOB_TYPE)
- `CustomMetricDimensionValue` type
- `CustomMetricUnit` enum (KILOBYTES, MILLISECONDS, MILLISECONDS_DETAILED, AGGREGATED_COUNT, INSTANTANEOUS_COUNT, MAGNITUDE, EVENT_COUNT)

### Step 4: Create custom-metrics.ts

Skeleton with:

- Empty `CustomMetric` enum (user will add values later)
- `expectedDimensionForMetric()` function — switch statement returning dimension per metric
- `unitForMetric()` function — switch statement returning unit per metric
- Add a placeholder example metric (e.g., `EXAMPLE_METRIC = 'example_metric'`) with a TODO comment, so the helper functions and OTel collector compile without an empty enum

### Step 5: Create custom-metrics-service.ts

Port the Symbol-based interface pattern:

- `CustomMetricsService` Symbol for DI
- `CustomMetricsService` interface with `logValue()`, `withLoggedExecTime()`, `withLoggedExecTimeForConnector()`

### Step 6: Create stub-metrics.service.ts

No-op implementation — all methods do nothing or just execute the closure. Used in tests.

### Step 7: Create dev-metrics.service.ts

Logs execution times via `WSLogger.info()`. `logValue()` is a no-op. Used in local development.

### Step 8: Create opentelemetry/opentelemetry-metric-collector.ts

Port from Whalesync with adaptations:

- Use `assertUnreachable` from `server/src/utils/asserts.ts` — note: Spinner's version doesn't have the `assertUnreachableButStillReturn` variant, so add a local helper or handle the default case differently (return a counter as fallback with a type cast)
- Same instrument creation logic (Counter, Gauge, Histogram based on unit type)
- Same histogram bucket configurations
- Same dimension/attribute handling

### Step 9: Create opentelemetry/opentelemetry-metrics.service.ts

Port from Whalesync with adaptations:

- Namespace: `'scratch'` (instead of `'bottlenose'`)
- Inject `ScratchConfigService` instead of `BottlenoseConfigService`
- Use `ScratchConfigService` methods for environment, service name, build version, and running-in-cloud checks
- Keep dual exporter setup (Prometheus pull + OTLP push)
- Implements `OnApplicationShutdown` for graceful shutdown

### Step 10: Create metrics.module.ts

Factory provider pattern:

- Inject `ScratchConfigService`
- Decision tree (simplified, no AWS):
  1. `APP_ENV === 'automated_test'` or `test` → `StubMetricsService`
  2. `configService.getUseOpenTelemetryMetrics()` → `OpenTelemetryMetricsService`
  3. Environment is `'development'` → `DevMetricsService`
  4. Default → `OpenTelemetryMetricsService`
- Import `ScratchConfigModule`
- Export `CustomMetricsService` symbol

### Step 11: Register MetricsModule in AppModule

Add `MetricsModule` to imports in `server/src/app.module.ts`.

### Step 12: Add env vars to .env.example

Add `USE_OPENTELEMETRY_METRICS=false` and `BUILD_VERSION=local` to `server/.env.example`.

### Step 13: Write unit test for opentelemetry-metric-collector

Port the test pattern from Whalesync — for each metric in the enum, verify the correct OTel instrument is created and the right method is called.

## Key Adaptations from Whalesync

| Whalesync                                   | Scratch                                                   |
| ------------------------------------------- | --------------------------------------------------------- |
| `BottlenoseConfigService`                   | `ScratchConfigService`                                    |
| `getWhalesyncEnvironment()`                 | `getScratchEnvironment()`                                 |
| `getRunningInCloud()`                       | `getRunningInCloud()` (new instance method)               |
| `BottlenoseConfigService.isAutomatedTest()` | `ScratchConfigService.getScratchEnvironment() === 'test'` |
| Namespace `'bottlenose'`                    | Namespace `'scratch'`                                     |
| `assertUnreachableButStillReturn`           | Local fallback helper or type-safe default                |
| CloudWatch path                             | Removed entirely                                          |
| `ExperimentsModule` import                  | Not needed                                                |
| 228+ CustomMetric values                    | Empty enum with placeholder + TODO                        |

## Files Modified (Existing)

- `server/src/config/scratch-config.service.ts` — add 3-4 new methods
- `server/src/app.module.ts` — import MetricsModule
- `server/.env.example` — add new env vars
- `server/package.json` — add OTel dependencies

## Verification

1. `yarn build` — ensure all packages compile
2. `yarn lint` — ensure no lint errors
3. `yarn test` — run tests including the new metric collector spec
4. Manual: In development, verify DevMetricsService is selected (check startup logs)
5. Manual: Set `USE_OPENTELEMETRY_METRICS=true` locally, verify OTel service initializes and Prometheus endpoint responds at `http://localhost:9464/metrics`
