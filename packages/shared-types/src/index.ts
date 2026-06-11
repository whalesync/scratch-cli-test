// Shared types exported for both client and server

// Import reflect-metadata for class-validator decorators in DTOs
import 'reflect-metadata';

// Enums shared between client and server
export * from './build';
export * from './email';
export * from './enums';

// Database entity types
export * from './db';

export * from './connector';
export * from './file-types';
// Canonical on-disk JSON serializer (2-space + trailing newline). Also available
// via the lean `@spinner/shared-types/format` subpath for bundlers that want it
// without the rest of the barrel.
export * from './format';
export * from './ids';
export * from './job-types';
export * from './subscription';
export * from './sync-mapping';
export * from './transformer-metadata';
export * from './whalesync-import';
export * from './workbook-events';

// DTOs
export * from './dto/bug-report/create-bug-report.dto';
export * from './dto/cli-auth/device-code.dto';
export * from './dto/code-migrations/code-migrations.dto';
export * from './dto/connector-account/connection-responses.dto';
export * from './dto/connector-account/create-connector-account.dto';
export * from './dto/connector-account/update-connector-account.dto';
export * from './dto/data-folder/create-data-folder.dto';
export * from './dto/data-folder/data-folder-publish-status.dto';
export * from './dto/data-folder/move-data-folder.dto';
export * from './dto/data-folder/rename-data-folder.dto';
export * from './dto/data-folder/update-data-folder.dto';
export * from './dto/desktop-release/desktop-release.dto';
export * from './dto/dev-tools/change-user-organization.dto';
export * from './dto/dev-tools/get-all-jobs.dto';
export * from './dto/dev-tools/update-dev-subscription.dto';
export * from './dto/dev-tools/user-detail.dto';
export * from './dto/generic-api/generic-api-responses.dto';
export * from './dto/internal/whalesync-internal.dto';
export * from './dto/oauth/oauth-initiate-options.dto';
export * from './dto/oauth/oauth-responses.dto';
export * from './dto/oauth/oauth-state-payload';
export * from './dto/payment/create-checkout-session.dto';
export * from './dto/payment/create-portal.dto';
export * from './dto/users/update-settings.dto';
export * from './dto/workbook/admin-workbook.dto';
export * from './dto/workbook/create-workbook.dto';
export * from './dto/workbook/delete-workbook.dto';
export * from './dto/workbook/file-details.dto';
export * from './dto/workbook/list-files.dto';
export * from './dto/workbook/list-workbooks-query.dto';
export * from './dto/workbook/pull-assets.dto';
export * from './dto/workbook/pull-files.dto';
export * from './dto/workbook/update-workbook.dto';

export * from './dto/publish-plan/publish-job-responses.dto';
export * from './dto/publish-plan/publish-plan.dto';
export * from './dto/schedule/create-schedule.dto';
export * from './dto/schedule/update-schedule.dto';
export * from './dto/schema/create-schema-responses.dto';
export * from './dto/schema/create-schema.dto';
export * from './dto/scratch-git/scratch-git.dto';
export * from './dto/sync/run-sync.dto';
export * from './dto/sync/sync-api';
export * from './dto/sync/whalesync-import-api';
export * from './dto/transformer/test-transformer.dto';
export * from './dto/upload-patch/upload-patch.dto';
export * from './dto/workspace-permission/workspace-permission.dto';
