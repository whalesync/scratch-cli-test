import { z } from 'zod';
import type { DecryptedCredentials } from '../../connector/credentials';

export const updateConnectorAccountSchema = z.object({
  displayName: z.string().min(1).optional(),
  // Text values only, as on create. A non-string value could read as "not sent" to a string check yet still reach a
  // connector that stringifies it into a URL (DEV-12723).
  userProvidedParams: z.record(z.string(), z.string()).optional(),
  modifier: z.string().optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
});

// `userProvidedParams` is validated as an object but typed as `Partial<DecryptedCredentials>`.
export type UpdateConnectorAccountDto = Omit<z.infer<typeof updateConnectorAccountSchema>, 'userProvidedParams'> & {
  userProvidedParams?: Partial<DecryptedCredentials>;
};

export type ValidatedUpdateConnectorAccountDto = UpdateConnectorAccountDto;
