/**
 * Build the display name for a brand-new destination parent container (a Google
 * Sheets spreadsheet, an Airtable base) that a connector spins up for a Live
 * Export batch, from the distinct source services feeding it — e.g. "Airtable
 * export", or "Airtable & HubSpot export" when a batch mixes sources. Returns
 * `undefined` when no source service could be resolved, letting the connector
 * fall back to its own generic default.
 *
 * Shared by materialize (which names the container) and create-plan generation
 * (which checks table-name conflicts in the container that name resolves to).
 */
export function buildNewDestinationParentName(sourceServiceDisplayNames: string[]): string | undefined {
  const distinctDisplayNames = [...new Set(sourceServiceDisplayNames)];
  if (distinctDisplayNames.length === 0) return undefined;
  return `${distinctDisplayNames.join(' & ')} export`;
}
