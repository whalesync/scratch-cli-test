import { z } from 'zod';
import type { Service } from '../../enums';
import { AuthType } from '../../enums';

export const createConnectorAccountSchema = z.object({
  // Validated as a non-empty string (original used @IsString @IsNotEmpty, not @IsEnum).
  service: z.string().min(1),
  userProvidedParams: z.record(z.string(), z.string()).optional(),
  /**
   * Optional structured extras supplied directly by the client. Used by connectors whose extras
   * shape is too rich for the string-only `userProvidedParams` path (currently: GENERIC_API). The
   * per-service type guard (e.g. isGenericApiConnectorExtras) validates the shape server-side.
   */
  extras: z.record(z.string(), z.unknown()).optional(),
  authType: z.nativeEnum(AuthType).optional(),
  modifier: z.string().optional(),
  displayName: z.string().optional(),
});

// `service` is validated as a string but carries the branded `Service` type for consumers.
export type CreateConnectorAccountDto = Omit<z.infer<typeof createConnectorAccountSchema>, 'service'> & {
  service: Service;
};

export type ValidatedCreateConnectorAccountDto = CreateConnectorAccountDto;
