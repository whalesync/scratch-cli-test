// CI rewrites the literal 'local' string below to the spinner pipeline's
// CI_COMMIT_SHORT_SHA at publish time (see gitlab-ci/stages/01-publish-shared-types.yml).
// Local builds, workspace consumers, and any non-publish CI keep 'local'.
export const BUILD = 'local';
