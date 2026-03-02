import { Flavor } from '@/utils/build';

const POSTHOG_PROJECT_ID: Record<string, string> = {
  [Flavor.Production]: '214130',
  [Flavor.Staging]: '225935',
  [Flavor.Local]: '225935',
};

export function posthogPersonUrl(userId: string, flavor: Flavor): string {
  const projectId = POSTHOG_PROJECT_ID[flavor] ?? POSTHOG_PROJECT_ID[Flavor.Staging];
  const columns = ['person_display_name -- Person', 'id', 'created_at', 'last_seen_at'];
  const query = {
    kind: 'DataTableNode',
    source: { kind: 'ActorsQuery', select: columns, search: userId },
    defaultColumns: columns,
    full: true,
    propertiesViaUrl: true,
    contextKey: 'people-list',
  };
  return `https://us.posthog.com/project/${projectId}/persons#q=${encodeURIComponent(JSON.stringify(query))}`;
}

export function clerkUserUrl(clerkId: string, flavor: Flavor): string {
  // these values are pulled from the clerk dashboard by going to the Users page and clicking on a specific user, then copying the URL
  if (flavor === Flavor.Production) {
    return `https://dashboard.clerk.com/apps/app_2ymxByR3cEOiOZGKx91GRzHZQ3f/instances/ins_31IAVihYbmlklAm4ErCH5ijgND5/users/${clerkId}`;
  } else {
    return `https://dashboard.clerk.com/apps/app_2ymxByR3cEOiOZGKx91GRzHZQ3f/instances/ins_2ymxBtQskUovRqqMFxDlz8s4QNT/users/${clerkId}`;
  }
}

export function stripeCustomerUrl(stripeId: string, flavor: Flavor): string {
  if (flavor === Flavor.Production) {
    return `https://dashboard.stripe.com/acct_1SNB1tBuGFTHqsGm/customers/${stripeId}`;
  } else if (flavor === Flavor.Staging) {
    return `https://dashboard.stripe.com/acct_1SNIphPd1pp0ErHM/test/customers/${stripeId}`;
  } else {
    return `https://dashboard.stripe.com/acct_1SNIouBdRE0kMHNq/test/customers/${stripeId}`;
  }
}
