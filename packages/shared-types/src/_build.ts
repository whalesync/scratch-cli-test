// CI rewrites the literal 'local' string below to the @spinner/shared-types
// version (0.0.0-<branch>-<sha>) both when publishing the package and when
// building the client image — the client bundles the workspace copy, so it has
// to be baked at image-build time too (see gitlab-ci/stages/01-publish-shared-types.yml
// and 01-build-and-test.yml). Workspace/local dev and other CI keep 'local'.
export const BUILD = 'local';
