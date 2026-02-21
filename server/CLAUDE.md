# Code style

- Do not use `as any` to solve type issues
- Do not use console.log, etc. to log. Instead, use WSLogger.info|warn|error.

# Workflow

- Be sure to test the build with `yarn run build` when you’re done making a series of code changes
- Run the formatter with `yarn run format` when you’re done making a series of code changes
- Regularly run the linter with `yarn run lint-strict` for code changes
- Prefer running single tests, and not the whole test suite, for performance
- Run the integration tests with `yarn run test:integration` when you're done making a series of code changes.

# Analytics and Tracking

The server has two channels for tracking user activities: Posthog and Audit Logging. Most user activities will require writing events to both channels.

## Posthog

Posthog provides standard analytics tracking activities and external aggregation and dashboards. These events are pushed to an external service vial the Posthog SDK.

- Tracked through the PosthogService
- Every event will take an Actor object to identify the user that took the action
- Posthog events are only used internally and never show to the user
- Tracking functions in PosthogService should NEVER throw errors or otherwise break the caller

## Audit Logging

Audit logs are persistent tracking of updates to a user or organizations data entities in Scratch. Audit logs are stored in the primary database.

- Tracked through the AuditLogService
- Every event will take an Actor object to identify the user that took the action along with the organization they belong to
- Audit log messages should be human-readable and user-friendly
- Audit logs will be visible to the user and can be exported
- Audit logs should be associated with an entity in the system and an eventType describing the interaction with that entity.

## What to track

- creating, updating or deleting core entities in the Scratch project that associated with the User, Organization or Workbook
  - i.e. creating a Workbook, deleting a Data Folder, modify a record file
- triggering asynchronous jobs related to a core entit
  - starting a pull job for a data source
  - downloading files from a data folder
- Changing permissions on an entity
- Adding or removing user from an organization
- Interactions through the `scratch-cli`
