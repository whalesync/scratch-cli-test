import { z } from 'zod';
import type { DecryptedCredentials } from '../../connector/credentials';

export const updateConnectorAccountSchema = z.object({
  displayName: z.string().min(1).optional(),
  userProvidedParams: z.record(z.string(), z.unknown()).optional(),
  modifier: z.string().optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
});

// `userProvidedParams` is validated as an object but typed as `Partial<DecryptedCredentials>`.
export type UpdateConnectorAccountDto = Omit<z.infer<typeof updateConnectorAccountSchema>, 'userProvidedParams'> & {
  userProvidedParams?: Partial<DecryptedCredentials>;
};

export type ValidatedUpdateConnectorAccountDto = UpdateConnectorAccountDto;
