import { updateSettingsSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge class for the shared update-settings request schema. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class UpdateSettingsDto extends createZodDto(updateSettingsSchema) {}
