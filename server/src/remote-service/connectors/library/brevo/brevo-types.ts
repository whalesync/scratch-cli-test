/** String union for the Brevo table types exposed by this connector. */
export type BrevoTableType = 'contacts' | 'templates' | 'mailing_lists';

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/** A contact returned by the Brevo API. */
export interface BrevoContact {
  email: string;
  id: number;
  emailBlacklisted: boolean;
  smsBlacklisted: boolean;
  createdAt: string;
  modifiedAt: string;
  listIds: number[];
  listUnsubscribed: number[];
  attributes: Record<string, unknown>;
}

/** A contact attribute definition from `GET /contacts/attributes`. */
export interface BrevoContactAttribute {
  name: string;
  category: 'normal' | 'transactional' | 'category' | 'calculated' | 'global';
  type: 'text' | 'date' | 'float' | 'id' | 'boolean' | 'multiple-choice';
  calculatedValue?: string;
  enumeration?: Array<{ label: string; value: number }>;
  multiCategoryOptions?: string[];
}

/** Body for `POST /contacts`. */
export interface BrevoCreateContactRequest {
  email?: string;
  ext_id?: string;
  attributes?: Record<string, unknown>;
  emailBlacklisted?: boolean;
  smsBlacklisted?: boolean;
  listIds?: number[];
  updateEnabled?: boolean;
}

/** Body for `PUT /contacts/{identifier}`. */
export interface BrevoUpdateContactRequest {
  attributes?: Record<string, unknown>;
  emailBlacklisted?: boolean;
  smsBlacklisted?: boolean;
  listIds?: number[];
  unlinkListIds?: number[];
  ext_id?: string;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface BrevoTemplateSender {
  name?: string | null;
  email?: string | null;
  id?: string | null;
}

/** A template returned by the Brevo API. */
export interface BrevoTemplate {
  id: number;
  name: string;
  subject: string;
  htmlContent: string;
  isActive: boolean;
  testSent: boolean;
  sender: BrevoTemplateSender;
  replyTo: string;
  toField: string;
  tag: string;
  createdAt: string;
  modifiedAt: string;
}

/** Body for `POST /smtp/templates`. */
export interface BrevoCreateTemplateRequest {
  templateName: string;
  subject: string;
  sender: { name?: string; email?: string; id?: number };
  htmlContent?: string;
  htmlUrl?: string;
  isActive?: boolean;
  replyTo?: string;
  toField?: string;
  tag?: string;
}

/** Body for `PUT /smtp/templates/{templateId}`. */
export interface BrevoUpdateTemplateRequest {
  templateName?: string;
  subject?: string;
  sender?: { name?: string; email?: string; id?: number };
  htmlContent?: string;
  htmlUrl?: string;
  isActive?: boolean;
  replyTo?: string;
  toField?: string;
  tag?: string;
}

// ---------------------------------------------------------------------------
// Mailing Lists
// ---------------------------------------------------------------------------

/** A mailing list returned by the Brevo API. */
export interface BrevoMailingList {
  id: number;
  name: string;
  totalSubscribers: number;
  uniqueSubscribers: number;
  totalBlacklisted: number;
  folderId: number;
  dynamicList: boolean;
  createdAt: string;
}

export interface BrevoMailingListsResponse {
  lists: BrevoMailingList[];
  count: number;
}

// ---------------------------------------------------------------------------
// Paginated responses
// ---------------------------------------------------------------------------

export interface BrevoContactsListResponse {
  contacts: BrevoContact[];
  count: number;
}

export interface BrevoTemplatesListResponse {
  templates: BrevoTemplate[];
  count: number;
}
