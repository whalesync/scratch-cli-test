/**
 * Response for the record-count endpoints — the total number of record files in scope
 * (a single workbook, or every workbook in an organization). Summed from the denormalized
 * per-folder `DataFolder.recordCount`, so it's a cheap aggregate, not a live git walk.
 */
export interface RecordCountResponseDto {
  recordCount: number;
}
