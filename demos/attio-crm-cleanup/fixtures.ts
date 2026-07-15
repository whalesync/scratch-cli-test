// Authored, deliberately-flawed CRM data for the Attio cleanup demo (DEV-10438).
//
// The flaws ARE the product. Two demo beats run on top of this baseline:
//
//   1. Enrich blanks from the domain (warm-up): every company is seeded with a domain but
//      NO industry (`categories`) and NO location (`primary_location`). The AI infers both
//      from the domain + name. Fixture names/domains are chosen so the right answer is
//      self-evident and checkable on the call: a ccTLD + a city/industry word in the name
//      (e.g. "Lyon Biotech" @ lyon-biotech.fr → France, Biotechnology).
//
//   2. Find + merge duplicates INCLUDING foreign keys (the hero): ~10 clusters where the
//      same company was entered a few times with drifted names ("Kyoto Robotics" / "KYOTO
//      ROBOTICS"). The survivor holds the real domain; the loser variants have NO domain
//      (so they can't even be enriched — junk records) but DO carry the things you'd hate to
//      lose: a headcount / funding / founded-date the survivor lacks, plus the People and
//      Deals attached to them. Merging combines the stray field into the survivor, repoints
//      every attached Person + Deal onto the survivor, and deletes the losers.
//
// `ground_truth` records the correct enrichment answer (for the run-of-show and a future
// pre-approved patch set). The seed NEVER writes it — enrichable fields go in blank.
//
// FK wiring is by `key`: seed.ts creates companies first, maps key -> Attio record id, then
// creates People / Deals resolving `company_key` -> that id. Loser variants are the usual FK
// targets so the merge has something to rescue.

export interface CompanyGroundTruth {
  country_code: string; // ISO 3166-1 alpha-2 — what enrich should discover from the domain
  locality: string; // HQ city (the grid shows locality for the location column)
  categories: string[]; // Attio `categories` option titles — the industry
}

export interface SeededCompany {
  key: string; // stable local key for FK wiring (never sent to Attio)
  name: string;
  domain?: string; // present on survivors + standalones; BLANK on loser duplicates
  // "combine" fields — data a loser carries that the survivor lacks (NOT domain-inferable,
  // so only the merge can recover them). At most one per loser keeps the story legible.
  employee_range?: string; // Attio `employee_range` option title (e.g. "51-250")
  funding_raised_usd?: number;
  foundation_date?: string; // YYYY-MM-DD
  ground_truth?: CompanyGroundTruth; // the correct enrichment (survivors + standalones only)
}

export interface SeededPerson {
  key: string;
  first_name: string;
  last_name: string;
  job_title: string;
  company_key: string; // FK target — usually a loser variant
}

export interface SeededDeal {
  key: string;
  name: string;
  stage: string; // 'Lead' | 'In Progress' | 'Won 🎉' | 'Lost'
  value_usd: number;
  company_key: string; // FK target — usually a loser variant
}

export interface DuplicateCluster {
  cluster_id: string;
  survivor: SeededCompany; // the canonical record to keep (holds the domain)
  losers: SeededCompany[]; // drifted duplicates to merge away (no domain; carry the strays)
}

// ---- The 10 duplicate clusters (the hero beat) ----

export const DUPLICATE_CLUSTERS: DuplicateCluster[] = [
  {
    cluster_id: 'kyoto-robotics',
    survivor: {
      key: 'kyoto-survivor',
      name: 'Kyoto Robotics',
      domain: 'kyoto-robotics.co.jp',
      ground_truth: { country_code: 'JP', locality: 'Kyoto', categories: ['Automation'] },
    },
    losers: [
      { key: 'kyoto-loser1', name: 'KYOTO ROBOTICS', employee_range: '251-1K' },
      { key: 'kyoto-loser2', name: 'Kyoto Robotics Inc.', foundation_date: '2014-06-01' },
    ],
  },
  {
    cluster_id: 'lyon-biotech',
    survivor: {
      key: 'lyon-survivor',
      name: 'Lyon Biotech',
      domain: 'lyon-biotech.fr',
      ground_truth: { country_code: 'FR', locality: 'Lyon', categories: ['Biotechnology'] },
    },
    losers: [{ key: 'lyon-loser1', name: 'Lyon Biotech SA', funding_raised_usd: 12_000_000 }],
  },
  {
    cluster_id: 'oslo-maritime',
    survivor: {
      key: 'oslo-survivor',
      name: 'Oslo Maritime',
      domain: 'oslo-maritime.no',
      ground_truth: { country_code: 'NO', locality: 'Oslo', categories: ['Maritime'] },
    },
    losers: [{ key: 'oslo-loser1', name: 'Oslo Maritime AS', employee_range: '51-250' }],
  },
  {
    cluster_id: 'berlin-analytics',
    survivor: {
      key: 'berlin-survivor',
      name: 'Berlin Analytics',
      domain: 'berlin-analytics.de',
      ground_truth: { country_code: 'DE', locality: 'Berlin', categories: ['SAAS'] },
    },
    losers: [{ key: 'berlin-loser1', name: 'Berlin Analytics GmbH', employee_range: '11-50' }],
  },
  {
    cluster_id: 'austin-coffee',
    survivor: {
      key: 'austin-survivor',
      name: 'Austin Coffee Roasters',
      domain: 'austincoffeeroasters.com',
      ground_truth: { country_code: 'US', locality: 'Austin', categories: ['Beverages'] },
    },
    losers: [
      { key: 'austin-loser1', name: 'Austin Coffee Roasters, Inc.', foundation_date: '2015-03-01' },
      { key: 'austin-loser2', name: 'Austin Coffee', employee_range: '11-50' },
    ],
  },
  {
    cluster_id: 'toronto-fintech',
    survivor: {
      key: 'toronto-survivor',
      name: 'Toronto Fintech',
      domain: 'toronto-fintech.ca',
      ground_truth: { country_code: 'CA', locality: 'Toronto', categories: ['Financial Services'] },
    },
    losers: [{ key: 'toronto-loser1', name: 'Toronto Fintech Inc', employee_range: '1K-5K' }],
  },
  {
    cluster_id: 'madrid-solar',
    survivor: {
      key: 'madrid-survivor',
      name: 'Madrid Solar',
      domain: 'madrid-solar.es',
      ground_truth: { country_code: 'ES', locality: 'Madrid', categories: ['Renewables & Environment'] },
    },
    losers: [{ key: 'madrid-loser1', name: 'Madrid Solar S.L.', employee_range: '51-250' }],
  },
  {
    cluster_id: 'sydney-health',
    survivor: {
      key: 'sydney-survivor',
      name: 'Sydney Health',
      domain: 'sydney-health.com.au',
      ground_truth: { country_code: 'AU', locality: 'Sydney', categories: ['Health Care'] },
    },
    losers: [{ key: 'sydney-loser1', name: 'SYDNEY HEALTH', employee_range: '251-1K' }],
  },
  {
    cluster_id: 'amsterdam-logistics',
    survivor: {
      key: 'amsterdam-survivor',
      name: 'Amsterdam Logistics',
      domain: 'amsterdam-logistics.nl',
      ground_truth: { country_code: 'NL', locality: 'Amsterdam', categories: ['Shipping & Logistics'] },
    },
    losers: [{ key: 'amsterdam-loser1', name: 'Amsterdam Logistics BV', employee_range: '1K-5K' }],
  },
  {
    cluster_id: 'dublin-games',
    survivor: {
      key: 'dublin-survivor',
      name: 'Dublin Games',
      domain: 'dublin-games.ie',
      ground_truth: { country_code: 'IE', locality: 'Dublin', categories: ['Video Games'] },
    },
    losers: [{ key: 'dublin-loser1', name: 'Dublin Games Ltd', employee_range: '11-50' }],
  },
];

// ---- Standalone (unique) companies — broaden the enrich beat's canvas ----

export const STANDALONE_COMPANIES: SeededCompany[] = [
  { key: 'milan', name: 'Milan Fashion House', domain: 'milan-fashion.it', ground_truth: { country_code: 'IT', locality: 'Milan', categories: ['Apparel & Footwear'] } },
  { key: 'zurich', name: 'Zurich Capital', domain: 'zurich-capital.ch', ground_truth: { country_code: 'CH', locality: 'Zurich', categories: ['Investment Management'] } },
  { key: 'seoul', name: 'Seoul Semiconductors', domain: 'seoul-semi.kr', ground_truth: { country_code: 'KR', locality: 'Seoul', categories: ['Computer Hardware'] } },
  { key: 'capetown', name: 'Cape Town Vineyards', domain: 'capetown-vineyards.co.za', ground_truth: { country_code: 'ZA', locality: 'Cape Town', categories: ['Beverages'] } },
  { key: 'stockholm', name: 'Stockholm Audio', domain: 'stockholm-audio.se', ground_truth: { country_code: 'SE', locality: 'Stockholm', categories: ['Audio'] } },
  { key: 'copenhagen', name: 'Copenhagen Design', domain: 'copenhagen-design.dk', ground_truth: { country_code: 'DK', locality: 'Copenhagen', categories: ['Design'] } },
  { key: 'mumbai', name: 'Mumbai Textiles', domain: 'mumbai-textiles.in', ground_truth: { country_code: 'IN', locality: 'Mumbai', categories: ['Textiles'] } },
  { key: 'saopaulo', name: 'São Paulo Agro', domain: 'saopaulo-agro.com.br', ground_truth: { country_code: 'BR', locality: 'São Paulo', categories: ['Agriculture'] } },
  { key: 'warsaw', name: 'Warsaw Software', domain: 'warsaw-software.pl', ground_truth: { country_code: 'PL', locality: 'Warsaw', categories: ['SAAS'] } },
  { key: 'helsinki', name: 'Helsinki Gaming', domain: 'helsinki-gaming.fi', ground_truth: { country_code: 'FI', locality: 'Helsinki', categories: ['Video Games'] } },
  { key: 'lisbon', name: 'Lisbon Tourism', domain: 'lisbon-tourism.pt', ground_truth: { country_code: 'PT', locality: 'Lisbon', categories: ['Travel & Leisure'] } },
  { key: 'vienna', name: 'Vienna Instruments', domain: 'vienna-instruments.at', ground_truth: { country_code: 'AT', locality: 'Vienna', categories: ['Music'] } },
  { key: 'brussels', name: 'Brussels Legal', domain: 'brussels-legal.be', ground_truth: { country_code: 'BE', locality: 'Brussels', categories: ['Legal Services'] } },
  { key: 'auckland', name: 'Auckland Dairy', domain: 'auckland-dairy.co.nz', ground_truth: { country_code: 'NZ', locality: 'Auckland', categories: ['Food Production'] } },
  { key: 'edinburgh', name: 'Edinburgh Whisky', domain: 'edinburgh-whisky.co.uk', ground_truth: { country_code: 'GB', locality: 'Edinburgh', categories: ['Beverages'] } },
];

// ---- People — most hang off loser variants (the FK "teeth"), a few off standalones ----

export const DEMO_PEOPLE: SeededPerson[] = [
  { key: 'p-hiroshi', first_name: 'Hiroshi', last_name: 'Tanaka', job_title: 'VP Engineering', company_key: 'kyoto-loser1' },
  { key: 'p-yuki', first_name: 'Yuki', last_name: 'Sato', job_title: 'Procurement Lead', company_key: 'kyoto-loser2' },
  { key: 'p-camille', first_name: 'Camille', last_name: 'Laurent', job_title: 'Head of R&D', company_key: 'lyon-loser1' },
  { key: 'p-erik', first_name: 'Erik', last_name: 'Johansen', job_title: 'Fleet Manager', company_key: 'oslo-loser1' },
  { key: 'p-anna', first_name: 'Anna', last_name: 'Müller', job_title: 'Data Lead', company_key: 'berlin-loser1' },
  { key: 'p-jonas', first_name: 'Jonas', last_name: 'Weber', job_title: 'CTO', company_key: 'berlin-loser1' },
  { key: 'p-sarah', first_name: 'Sarah', last_name: 'Mitchell', job_title: 'Owner', company_key: 'austin-loser1' },
  { key: 'p-diego', first_name: 'Diego', last_name: 'Ramirez', job_title: 'Head Roaster', company_key: 'austin-loser2' },
  { key: 'p-priya', first_name: 'Priya', last_name: 'Patel', job_title: 'Compliance Officer', company_key: 'toronto-loser1' },
  { key: 'p-mateo', first_name: 'Mateo', last_name: 'García', job_title: 'Project Lead', company_key: 'madrid-loser1' },
  { key: 'p-olivia', first_name: 'Olivia', last_name: 'Brown', job_title: 'Clinical Director', company_key: 'sydney-loser1' },
  { key: 'p-lars', first_name: 'Lars', last_name: 'de Vries', job_title: 'Operations Manager', company_key: 'amsterdam-loser1' },
  { key: 'p-aoife', first_name: 'Aoife', last_name: 'Kelly', job_title: 'Studio Head', company_key: 'dublin-loser1' },
  // a few on standalone companies (no merge — just realistic CRM density)
  { key: 'p-thomas', first_name: 'Thomas', last_name: 'Meier', job_title: 'Portfolio Manager', company_key: 'zurich' },
  { key: 'p-minjun', first_name: 'Min-jun', last_name: 'Kim', job_title: 'Supply Chain Lead', company_key: 'seoul' },
  { key: 'p-zofia', first_name: 'Zofia', last_name: 'Nowak', job_title: 'Engineering Lead', company_key: 'warsaw' },
  { key: 'p-joana', first_name: 'Joana', last_name: 'Costa', job_title: 'Marketing Director', company_key: 'lisbon' },
];

// ---- Deals — most hang off loser variants (FK teeth), a few off standalones ----

export const DEMO_DEALS: SeededDeal[] = [
  { key: 'd-kyoto', name: 'Kyoto Robotics — Automation Rollout', stage: 'In Progress', value_usd: 85_000, company_key: 'kyoto-loser1' },
  { key: 'd-lyon', name: 'Lyon Biotech — Platform License', stage: 'Lead', value_usd: 42_000, company_key: 'lyon-loser1' },
  { key: 'd-berlin', name: 'Berlin Analytics — Analytics Suite', stage: 'In Progress', value_usd: 60_000, company_key: 'berlin-loser1' },
  { key: 'd-austin', name: 'Austin Coffee — Wholesale Supply', stage: 'Lead', value_usd: 15_000, company_key: 'austin-loser1' },
  { key: 'd-toronto', name: 'Toronto Fintech — Compliance Module', stage: 'In Progress', value_usd: 120_000, company_key: 'toronto-loser1' },
  { key: 'd-sydney', name: 'Sydney Health — EHR Integration', stage: 'Lead', value_usd: 95_000, company_key: 'sydney-loser1' },
  { key: 'd-amsterdam', name: 'Amsterdam Logistics — Route Optimization', stage: 'Won 🎉', value_usd: 70_000, company_key: 'amsterdam-loser1' },
  // a few on standalone companies
  { key: 'd-zurich', name: 'Zurich Capital — Advisory Retainer', stage: 'In Progress', value_usd: 200_000, company_key: 'zurich' },
  { key: 'd-warsaw', name: 'Warsaw Software — SaaS Renewal', stage: 'Lead', value_usd: 30_000, company_key: 'warsaw' },
  { key: 'd-edinburgh', name: 'Edinburgh Whisky — Export Deal', stage: 'Won 🎉', value_usd: 50_000, company_key: 'edinburgh' },
];

// ---- Derived views (flat lists + name sets for the by-name teardown) ----

export const ALL_SEEDED_COMPANIES: SeededCompany[] = [
  ...DUPLICATE_CLUSTERS.flatMap((cluster) => [cluster.survivor, ...cluster.losers]),
  ...STANDALONE_COMPANIES,
];

export const ALL_DEMO_COMPANY_NAMES: ReadonlySet<string> = new Set(ALL_SEEDED_COMPANIES.map((c) => c.name));
export const ALL_DEMO_PERSON_NAMES: ReadonlySet<string> = new Set(
  DEMO_PEOPLE.map((p) => `${p.first_name} ${p.last_name}`),
);
export const ALL_DEMO_DEAL_NAMES: ReadonlySet<string> = new Set(DEMO_DEALS.map((d) => d.name));
