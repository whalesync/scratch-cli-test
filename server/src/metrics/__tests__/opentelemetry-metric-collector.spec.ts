import { CustomMetric, unitForMetric } from '../custom-metrics';
import { OpenTelemetryMetric } from '../opentelemetry/opentelemetry-metric-collector';
import { CustomMetricUnit } from '../types';

describe('OpenTelemetryMetric', () => {
  const allMetrics = Object.values(CustomMetric);

  it.each(allMetrics)('should create the correct instrument and record a value for %s', (metric) => {
    const addMock = jest.fn();
    const recordMock = jest.fn();

    const mockCounter = { add: addMock };
    const mockHistogram = { record: recordMock };
    const mockGauge = { record: recordMock };

    const mockMeter = {
      createCounter: jest.fn().mockReturnValue(mockCounter),
      createHistogram: jest.fn().mockReturnValue(mockHistogram),
      createGauge: jest.fn().mockReturnValue(mockGauge),
    };

    const otelMetric = new OpenTelemetryMetric(metric, mockMeter as never);
    otelMetric.addValue(42);

    const unit = unitForMetric(metric);
    const totalCalls = addMock.mock.calls.length + recordMock.mock.calls.length;
    expect(totalCalls).toBe(1);

    switch (unit) {
      case CustomMetricUnit.EVENT_COUNT:
      case CustomMetricUnit.AGGREGATED_COUNT:
        expect(mockMeter.createCounter).toHaveBeenCalled();
        expect(addMock).toHaveBeenCalledWith(42, expect.any(Object));
        break;
      case CustomMetricUnit.INSTANTANEOUS_COUNT:
      case CustomMetricUnit.KILOBYTES:
        expect(mockMeter.createGauge).toHaveBeenCalled();
        expect(recordMock).toHaveBeenCalledWith(42, expect.any(Object));
        break;
      case CustomMetricUnit.MILLISECONDS:
      case CustomMetricUnit.MILLISECONDS_DETAILED:
      case CustomMetricUnit.MAGNITUDE:
        expect(mockMeter.createHistogram).toHaveBeenCalled();
        expect(recordMock).toHaveBeenCalledWith(42, expect.any(Object));
        break;
    }
  });
});
