import { JsonSafeObject } from 'src/utils/objects';

export type Progress<
  TPublicProgress extends JsonSafeObject = JsonSafeObject,
  TJobProgress extends JsonSafeObject = JsonSafeObject,
  TConnectorProgress extends JsonSafeObject = JsonSafeObject,
> = {
  publicProgress: TPublicProgress;
  jobProgress: TJobProgress;
  connectorProgress: TConnectorProgress;
  timestamp: number;
};
