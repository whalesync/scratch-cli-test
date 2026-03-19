# OpenTelemetry Collector configuration
resource "google_secret_manager_secret" "OTEL_COLLECTOR_CONFIG" {
  count     = var.use_opentelemetry_metrics ? 1 : 0
  secret_id = "OTEL_COLLECTOR_CONFIG"
  replication {
    auto {}
  }
}

# Config file for google-cloud-opentelemetry-collector
# Based on https://github.com/GoogleCloudPlatform/opentelemetry-operations-collector/blob/v0.138.0/google-built-opentelemetry-collector/docs/examples/configuration/config-standard.yaml
# See https://github.com/open-telemetry/opentelemetry-configuration/blob/8c83c97/examples/kitchen-sink.yaml for examples
resource "terraform_data" "otel_collector_config" {
  count = var.use_opentelemetry_metrics ? 1 : 0
  input = <<-EOT
  receivers:
    # Open two OTLP servers:
    # - On port 4317, open an OTLP GRPC server
    # - On port 4318, open an OTLP HTTP server
    #
    # Docs:
    # https://github.com/open-telemetry/opentelemetry-collector/tree/main/receiver/otlpreceiver
    otlp:
      protocols:
        grpc:
          endpoint: localhost:4317
        http:
          cors:
            # This effectively allows any origin
            # to make requests to the HTTP server.
            allowed_origins:
            - http://*
            - https://*
          endpoint: localhost:4318

  processors:
    # The batch processor is in place to regulate both the number of requests
    # being made and the size of those requests.
    #
    # Docs:
    # https://github.com/open-telemetry/opentelemetry-collector/tree/main/processor/batchprocessor
    batch:
      send_batch_max_size: 200
      send_batch_size: 200
      timeout: 5s

    # The memorylimiter will check the memory usage of the collector process.
    #
    # Docs:
    # https://github.com/open-telemetry/opentelemetry-collector/tree/main/processor/memorylimiterprocessor
    memory_limiter:
      check_interval: 1s
      limit_percentage: 65
      spike_limit_percentage: 20

    # The resourcedetection processor is configured to detect GCP resources.
    # Resource attributes that represent the GCP resource the collector is
    # running on will be attached to all telemetry that goes through this
    # processor.
    #
    # Docs:
    # https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/resourcedetectionprocessor
    # https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/resourcedetectionprocessor#gcp-metadata
    resourcedetection:
      detectors: [gcp]
      timeout: 10s

    transform/collision:
      metric_statements:
      - context: datapoint
        statements:
        - set(attributes["exported_location"], attributes["location"])
        - delete_key(attributes, "location")
        - set(attributes["exported_cluster"], attributes["cluster"])
        - delete_key(attributes, "cluster")
        - set(attributes["exported_namespace"], attributes["namespace"])
        - delete_key(attributes, "namespace")
        - set(attributes["exported_job"], attributes["job"])
        - delete_key(attributes, "job")
        - set(attributes["exported_instance"], attributes["instance"])
        - delete_key(attributes, "instance")
        - set(attributes["exported_project_id"], attributes["project_id"])
        - delete_key(attributes, "project_id")

    filter/drop_metrics_by_name:
      metrics:
        exclude:
          match_type: strict
          metric_names:
            - otel_scope_info

  exporters:
    # The googlemanagedprometheus exporter will send metrics to
    # Google Managed Service for Prometheus.
    #
    # Docs:
    # https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/googlemanagedprometheusexporter
    googlemanagedprometheus:

  extensions:
    # Opens an endpoint on 13133 that can be used to check the
    # status of the collector. Since this does not configure the
    # `path` config value, the endpoint will default to `/`.
    #
    # When running on Cloud Run, this extension is required and not optional.
    # In other environments it is recommended but may not be required for operation
    # (i.e. in Container-Optimized OS or other GCE environments).
    #
    # Docs:
    # https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/extension/healthcheckextension
    health_check:
      endpoint: 0.0.0.0:13133

  service:
    extensions:
    - health_check
    pipelines:
      metrics/otlp:
        receivers:
        - otlp
        processors:
        - filter/drop_metrics_by_name
        - resourcedetection
        - transform/collision
        - memory_limiter
        - batch
        exporters:
        - googlemanagedprometheus

    # Internal telemetry for the collector supports both push and pull-based telemetry data transmission.
    # Leveraging the pre-configured OTLP receiver eliminates the need for an additional port.
    #
    # Docs:
    # https://opentelemetry.io/docs/collector/internal-telemetry/
    telemetry:
      metrics:
        level: basic
        readers:
          - periodic:
              interval: 60000
              timeout: 30000
              exporter:
                otlp:
                  protocol: grpc
                  endpoint: localhost:4317
                  # This can be removed if you configure tls
                  # settings on your otlp receiver.
                  insecure: true
  EOT
}

resource "google_secret_manager_secret_version" "OTEL_COLLECTOR_CONFIG" {
  count           = var.use_opentelemetry_metrics ? 1 : 0
  secret          = google_secret_manager_secret.OTEL_COLLECTOR_CONFIG[0].id
  secret_data     = terraform_data.otel_collector_config[0].output
  deletion_policy = "ABANDON"
}
