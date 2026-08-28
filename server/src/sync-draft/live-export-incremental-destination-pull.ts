import type { JsonValue } from 'src/experiments/types';
import { z } from 'zod';

/**
 * Payload contract for `ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL`: a plain JSON array of
 * connector service ids (`["NOTION", "AIRTABLE"]`, matched case-insensitively) naming the
 * destination connectors whose Live Export pull may run incrementally, or `["*"]` for every
 * connector. An empty array enrols nothing. Anything else is malformed and callers treat it as
 * "nothing enrolled" (fail-closed), so a typo can never opt every destination in by accident.
 */
export const ALL_DESTINATION_SERVICES_WILDCARD = '*';

const incrementalPullDestinationServicesPayloadSchema = z.array(z.string().trim().min(1));

export type IncrementalPullDestinationServices =
  | { allServices: true }
  | { allServices: false; services: ReadonlySet<string> };

/** `null` = malformed payload. */
export function parseIncrementalPullDestinationServicesPayload(
  payload: JsonValue,
): IncrementalPullDestinationServices | null {
  const parsed = incrementalPullDestinationServicesPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }
  const services = parsed.data.map((service) => service.toUpperCase());
  if (services.includes(ALL_DESTINATION_SERVICES_WILDCARD)) {
    return { allServices: true };
  }
  return { allServices: false, services: new Set(services) };
}

/** Whether a destination connection of `service` (a `ConnectorAccount.service`) is enrolled. */
export function isIncrementalPullDestinationService(
  enrolled: IncrementalPullDestinationServices,
  service: string | null | undefined,
): boolean {
  if (enrolled.allServices) return true;
  return typeof service === 'string' && enrolled.services.has(service.toUpperCase());
}
