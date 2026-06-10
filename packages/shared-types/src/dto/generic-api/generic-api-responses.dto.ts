import { GenericApiFolderOptions } from '../../connector/metadata';

/** Response for `GET /connectors/generic-api/ai-prompt`. */
export interface GenericApiAiPromptResponse {
  version: string;
  text: string;
}

/** Response for `POST .../generic-api/:connectorAccountId/probe-endpoint`. */
export interface ProbeEndpointResponse {
  probe: GenericApiFolderOptions['probe'];
  recordsWalked: number;
  page1RecordCount: number;
  page2RecordCount: number;
  page2Status: 'ok' | 'no-pagination';
}

export interface ReprobeDiff {
  idPathChanged: boolean;
  paginationStrategyChanged: boolean;
  schemaFieldsAdded: string[];
  schemaFieldsRemoved: string[];
}

/** Response for `POST .../generic-api/data-folders/:dataFolderId/reprobe`. */
export interface ReprobeResponse {
  applied: boolean;
  diff: ReprobeDiff;
  newProbe: GenericApiFolderOptions['probe'];
}
