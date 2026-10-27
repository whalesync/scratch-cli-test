/**
 * Salesforce REST API version this connector speaks. Pinned rather than "latest" because the version is
 * part of every pulled record: each record's `attributes.url` reads `/services/data/<version>/sobjects/...`,
 * so bumping it rewrites that key on every stored record at the next pull.
 */
export const SALESFORCE_API_VERSION = 'v66.0';

/** OAuth host for production and Developer Edition orgs. */
export const SALESFORCE_PRODUCTION_LOGIN_HOST = 'login.salesforce.com';

/** OAuth host for sandbox orgs. Sandboxes reject sign-ins and code exchanges at login.salesforce.com. */
export const SALESFORCE_SANDBOX_LOGIN_HOST = 'test.salesforce.com';

/** The OAuth host to authorize and exchange codes against, chosen server-side from the connect form's yes/no. */
export function salesforceLoginHost(useSandboxLoginHost: boolean): string {
  return useSandboxLoginHost ? SALESFORCE_SANDBOX_LOGIN_HOST : SALESFORCE_PRODUCTION_LOGIN_HOST;
}

/**
 * Domains Salesforce serves org instances from: `*.my.salesforce.com` (production, sandbox, Developer Edition,
 * scratch orgs and legacy `naXX`/`csXX` instances), `*.force.com` / `*.cloudforce.com` (older instance hosts),
 * `*.salesforce.mil` (Government Cloud Plus – Defense), and `*.sfcrmproducts.cn` (Salesforce China).
 */
const SALESFORCE_INSTANCE_HOST_SUFFIXES = [
  '.salesforce.com',
  '.force.com',
  '.cloudforce.com',
  '.salesforce.mil',
  '.sfcrmproducts.cn',
];

/**
 * Normalize the org's `instance_url` (from Salesforce's token response, e.g.
 * `https://acme.my.salesforce.com`) to its bare origin, rejecting anything that is not an https origin on a
 * Salesforce domain.
 *
 * The instance URL is where every API call and every token refresh goes — a refresh sends the system connected
 * app's client secret along with the refresh token. The stored copy sits in the connection's credentials, which a
 * connection edit can overwrite, so it must name a Salesforce host and carry no path, query, or credentials that
 * would send a request anywhere else.
 */
export function parseSalesforceInstanceUrl(instanceUrlFromTokenResponse: string | undefined | null): string {
  if (!instanceUrlFromTokenResponse) {
    throw new Error('Salesforce did not return an instance URL for this org');
  }
  let parsedInstanceUrl: URL;
  try {
    parsedInstanceUrl = new URL(instanceUrlFromTokenResponse);
  } catch {
    throw new Error(`Salesforce returned an instance URL that is not a URL: ${instanceUrlFromTokenResponse}`);
  }
  const hasOnlyAnOrigin =
    (parsedInstanceUrl.pathname === '/' || parsedInstanceUrl.pathname === '') &&
    parsedInstanceUrl.search === '' &&
    parsedInstanceUrl.hash === '' &&
    parsedInstanceUrl.username === '' &&
    parsedInstanceUrl.password === '';
  const isOnASalesforceDomain = SALESFORCE_INSTANCE_HOST_SUFFIXES.some((suffix) =>
    parsedInstanceUrl.hostname.endsWith(suffix),
  );
  if (parsedInstanceUrl.protocol !== 'https:' || !hasOnlyAnOrigin || !isOnASalesforceDomain) {
    throw new Error(`Salesforce returned an unexpected instance URL: ${instanceUrlFromTokenResponse}`);
  }
  return parsedInstanceUrl.origin;
}

/** One entry of `GET /sobjects` — the org's object catalog. Only the flags the connector reads are typed. */
export interface SalesforceSObjectSummary {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  customSetting: boolean;
  queryable: boolean;
  retrieveable: boolean;
  layoutable: boolean;
  deprecatedAndHidden: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
}

export interface SalesforceSObjectListResponse {
  encoding: string;
  maxBatchSize: number;
  sobjects: SalesforceSObjectSummary[];
}

/** One picklist entry from a field's describe. */
export interface SalesforcePicklistValue {
  value: string;
  label: string | null;
  active: boolean;
  defaultValue: boolean;
}

/**
 * One field from `GET /sobjects/{object}/describe`. `type` is Salesforce's field type (`string`, `picklist`,
 * `reference`, `address`, …); `extraTypeInfo` refines it (`richtextarea`, `plaintextarea`, `personname`, …).
 */
export interface SalesforceFieldDescribe {
  name: string;
  label: string;
  type: string;
  soapType: string;
  extraTypeInfo: string | null;
  custom: boolean;
  createable: boolean;
  updateable: boolean;
  nillable: boolean;
  defaultedOnCreate: boolean;
  calculated: boolean;
  autoNumber: boolean;
  nameField: boolean;
  length: number;
  precision: number;
  scale: number;
  referenceTo: string[];
  relationshipName: string | null;
  compoundFieldName: string | null;
  picklistValues: SalesforcePicklistValue[];
  restrictedPicklist: boolean;
  inlineHelpText: string | null;
}

/** `GET /sobjects/{object}/describe`. Only the members the connector reads are typed. */
export interface SalesforceSObjectDescribe {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  createable: boolean;
  updateable: boolean;
  deletable: boolean;
  queryable: boolean;
  fields: SalesforceFieldDescribe[];
}

/**
 * A record exactly as SOQL (or the single-record GET) returns it: an `attributes` block naming the object type
 * and the record's REST URL, then one key per selected field. Stored verbatim.
 */
export type SalesforceRecord = Record<string, unknown> & {
  attributes?: { type: string; url?: string };
  Id?: string;
};

/** `GET /query` and `GET {nextRecordsUrl}`. `totalSize`/`done`/`nextRecordsUrl` are the transport envelope. */
export interface SalesforceQueryResponse {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  records: SalesforceRecord[];
}

/** One error inside an sObject Collections result. */
export interface SalesforceSaveResultError {
  statusCode: string;
  message: string;
  fields: string[];
}

/** One element of an sObject Collections (`/composite/sobjects`) response, in request order. */
export interface SalesforceSaveResult {
  id?: string;
  success: boolean;
  errors: SalesforceSaveResultError[];
}

/** One element of the array Salesforce returns as the body of a failed REST call. */
export interface SalesforceRestErrorBody {
  errorCode: string;
  message: string;
  fields?: string[];
}

/** `POST /composite` response, used to run a query whose URL is too long for a plain GET. */
export interface SalesforceCompositeResponse {
  compositeResponse: {
    body: unknown;
    httpStatusCode: number;
    referenceId: string;
  }[];
}

/**
 * Resume point for a pull. Records are queried in `Id` order, so a pull that stalls restarts with
 * `Id > lastPulledRecordId` instead of from the first record — query cursors (`nextRecordsUrl`) expire after
 * 15 minutes of inactivity and can't be relied on across a job restart.
 */
export interface SalesforceDownloadProgress {
  [key: string]: string | undefined;
  lastPulledRecordId?: string;
  /**
   * ISO instant captured before the pull's first request. A resumed run keeps the original run's watermark, so
   * records modified after the original start but sorted before `lastPulledRecordId` are re-pulled next time.
   */
  pullWatermark?: string;
}
