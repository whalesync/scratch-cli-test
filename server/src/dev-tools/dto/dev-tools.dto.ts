import { changeUserOrganizationSchema, updateDevSubscriptionSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge classes for the shared dev-tools request schemas. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class ChangeUserOrganizationDto extends createZodDto(changeUserOrganizationSchema) {}
export class UpdateDevSubscriptionDto extends createZodDto(updateDevSubscriptionSchema) {}
