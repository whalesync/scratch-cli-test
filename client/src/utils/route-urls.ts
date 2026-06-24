/**
 * Maps a Scratch web path to scratch:// for the desktop app.
 * Supports /workbook/... and /workspace/{workbookId}/... (workspace URLs open that workbook in desktop).
 */
function appendWebappSource(deepLink: string): string {
  const separator = deepLink.includes('?') ? '&' : '?';
  return `${deepLink}${separator}source=webapp`;
}

export function desktopDeepLinkFromWebPath(webPath: string): string | null {
  const trimmed = webPath.replace(/^\/+/, '');
  const [pathname, query = ''] = trimmed.split('?');
  const querySuffix = query ? `?${query}` : '';
  if (pathname.startsWith('workbook/')) {
    return appendWebappSource(`scratch://${pathname}${querySuffix}`);
  }
  const workspaceMatch = /^workspace\/([^/]+)/.exec(pathname);
  if (workspaceMatch) {
    return appendWebappSource(`scratch://workbook/${workspaceMatch[1]}${querySuffix}`);
  }
  return null;
}

export class RouteUrls {
  // Public routes
  static healthEndpoint = '/api/health';
  static pricingPageUrl = '/pricing';

  /** macOS desktop installer landing page (see also home page desktop CTA). */
  static downloadsPageUrl = '/downloads';

  // Not implemented yet, just placeholder for future use
  static signInPageUrl = '/sign-in';
  static signInPageWithRedirect = (redirect_url: string) => `${this.signInPageUrl}?redirect_url=${redirect_url}`;
  // Not implemented yet, just placeholder for future use
  static signUpPageUrl = '/sign-up';
  static signUpPageWithRedirect = (redirect_url: string) => `${this.signUpPageUrl}?redirect_url=${redirect_url}`;
  static signOutPageUrl = '/sign-out';

  // Authenticated Routes & Route Generators
  static homePageUrl = '/'; // Root page handles redirect to workbook
  static healthPageUrl = '/health';
  // Auth-gated claim page for a marketplace-initiated ("inbound") OAuth install.
  static connectClaimPageUrl = (service: string) => `/connect/${service}`;
  static workbookPickerPageUrl = '/workbook'; // Always renders the workspace picker
  static workbookPageUrl = (id: string) => `/workbook/${id}`;
  static workbookFilesPageUrl = (id: string) => `/workbook/${id}/files`;
  static workbookFilesFileUrl = (id: string, filePath: string) => {
    const encoded = filePath
      .replace(/^\/+/, '')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `/workbook/${id}/files/${encoded}`;
  };
  static workbookReviewPageUrl = (id: string) => `/workbook/${id}/review`;
  static workbookReviewFileUrl = (id: string, connectorAccountId: string, filePath: string) => {
    const encoded = filePath
      .replace(/^\/+/, '')
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `/workbook/${id}/review/${encodeURIComponent(connectorAccountId)}/${encoded}`;
  };
  static workbookSyncsPageUrl = (id: string) => `/workbook/${id}/syncs`;
  static workbookScheduledRunsPageUrl = (id: string) => `/workbook/${id}/runs/scheduled`;
  static workbookRunsPageUrl = (id: string, params?: Record<string, string>) => {
    const base = `/workbook/${id}/runs`;
    if (!params) return base;
    const search = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== ''),
    ).toString();
    return search ? `${base}?${search}` : base;
  };
  static settingsPageUrl = '/settings';
  static settingsUserPageUrl = '/settings/user';
  static settingsApiKeyPageUrl = '/settings/api-key';
  static billingPageUrl = '/settings/billing';
  static productCheckoutPage = (planType: string, returnPath?: string) =>
    `/subscription/checkout/${planType}${returnPath ? `?returnPath=${returnPath}` : ''}`;

  // Waitlist
  static waitlistPageUrl = '/waitlist';

  /**
   * scratch:// URL that opens this workbook in Scratch Desktop (in-app route /workspace/{id}).
   * Desktop maps web-style workbook/* paths via mapWebWorkbookPathToDesktopRoute.
   */
  static desktopDeepLinkForWorkbook(workbookId: string): string {
    return appendWebappSource(`scratch://workbook/${workbookId}`);
  }

  /** @see desktopDeepLinkFromWebPath */
  static readonly desktopDeepLinkFromWebPath = desktopDeepLinkFromWebPath;

  /**
   * Builds a scratch:// deep link for a workbook-related web pathname (e.g. /workbook/{id}/files).
   * Returns null when the path is not under /workbook/ or /workspace/{id}/.
   */
  static desktopDeepLinkForWebPathname(pathname: string): string | null {
    return desktopDeepLinkFromWebPath(pathname);
  }

  /**
   * Web URL that attempts to open the desktop app first, then offers a browser fallback (see /open/[...path]).
   */
  static openInDesktopIntermediaryUrl(webPath: string): string {
    const trimmed = webPath.replace(/^\/+/, '');
    return `/open/${trimmed}`;
  }

  /**
   * HTTP relay URL for environments that will not open custom protocol links directly.
   */
  static openDesktopDeepLinkRelayUrl(deepLink: string): string {
    return `/open-desktop?url=${encodeURIComponent(deepLink)}`;
  }

  // Dev Tools routes (under settings)
  static devToolsPageUrl = '/settings/dev/user-info';
  static devToolsWaitlistPageUrl = '/settings/dev/waitlist';
  static devToolsUserInfoPageUrl = '/settings/dev/user-info';
  static devToolsUsersPageUrl = '/settings/dev/users';
  static devToolsGalleryPageUrl = '/settings/dev/gallery';
  static devToolsJobsPageUrl = '/settings/dev/jobs';
  static devToolsCronPageUrl = '/settings/dev/cron';
  static devToolsMigrationsPageUrl = '/settings/dev/migrations';
  static devToolsSyncDataFoldersPageUrl = '/settings/dev/sync-data-folders';

  /** Utils */

  static publicRoutePatterns = [
    this.healthEndpoint,
    this.pricingPageUrl,
    this.downloadsPageUrl,
    '/open(.*)',
    '/open-desktop',
    this.signInPageUrl,
    this.signUpPageUrl,
    this.signOutPageUrl,
    // The OAuth provider's registered redirect_uri lands here. This page only base64-decodes the
    // `state` param and forwards the result on (to the scratch:// desktop app, a Whalesync/dusky
    // origin, or the scratch-web callback-step-2) — it never reads user or auth data, so it must be
    // reachable without a scratch.md login. Anchored as a RegExp so it matches ONLY /oauth/callback
    // and NOT /oauth/callback-step-2 (which exchanges the code and stays auth-gated): isPublicRoute
    // uses an unanchored `new RegExp(pattern)`, where the bare string '/oauth/callback' would also
    // match the step-2 path as a substring.
    /^\/oauth\/callback$/,
    // Marketplace-initiated ("inbound") OAuth lands here (e.g. /oauth/install/gohighlevel). The page
    // only reads the `code` from the URL and posts it to the public redeem endpoint, then forwards to
    // the auth-gated /connect/:service claim page — it must be reachable with no scratch.md login,
    // because the installing user may not have an account yet.
    /^\/oauth\/install\/[^/]+$/,
  ];

  /**
   * Public routes are endpoints that don't require any authentication, user identification or JWT tokens
   * Pretty much limited to health check endpoints and signin/signup pages
   */
  static isPublicRoute(pathname: string): boolean {
    return RouteUrls.publicRoutePatterns.some((pattern) => new RegExp(pattern).test(pathname));
  }

  static subscriptionRoutePatterns = [
    `^\/$`, // root path
    '/workbook',
  ];

  /** Routes that require an active subscription or free trial to access*/
  static isSubscribedOnlyRoute(pathname: string): boolean {
    return RouteUrls.subscriptionRoutePatterns.some((pattern) => new RegExp(pattern).test(pathname));
  }

  /**
   * Updates the URL path for file-based workbook views.
   * @param workbookId - The ID of the workbook
   * @param viewType - The view type: 'files' or 'review'
   * @param filePath - The file path (optional)
   */
  static updateWorkbookFilePath = (workbookId: string, viewType?: 'files' | 'review', filePath?: string) => {
    let url = `/workbook/${workbookId}`;

    if (viewType) {
      url += `/${viewType}`;
      if (filePath) {
        // Strip leading slashes to avoid double slashes
        const cleanPath = filePath.replace(/^\/+/, '');
        if (cleanPath) {
          url += `/${cleanPath}`;
        }
      }
    }

    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', url);
    }
  };
}
