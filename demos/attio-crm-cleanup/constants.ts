// Shared identity of the Attio CRM-cleanup demo.
// Kept in its own module (not in seed.ts) so reset.ts can import it WITHOUT pulling in
// seed.ts's executable body.

// Attio standard-object slugs the demo touches (also the `linked available` table ids).
export const COMPANIES_OBJECT_SLUG = 'companies';
export const PEOPLE_OBJECT_SLUG = 'people';
export const DEALS_OBJECT_SLUG = 'deals';

// Scratch-side identity (bootstrap.ts).
export const DEMO_WORKBOOK_NAME = 'Attio CRM Cleanup Demo';
export const DEMO_ATTIO_CONNECTION_NAME = 'Attio (Demo)';
export const DEMO_COMPANIES_FOLDER_NAME = 'Companies';
export const DEMO_PEOPLE_FOLDER_NAME = 'People';
export const DEMO_DEALS_FOLDER_NAME = 'Deals';
