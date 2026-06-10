/** Response for `POST .../publish-v2/plan-job`. */
export interface PlanJobResponse {
  jobId: string | number | null;
  pipelineId: string | null;
}

/** Response for `POST .../publish-v2/run-job`. */
export interface RunJobResponse {
  jobId: string | number | null;
}

/** Response for `GET /scratch-git/:id/file`. */
export interface RepoFileResponse {
  content: string;
}
