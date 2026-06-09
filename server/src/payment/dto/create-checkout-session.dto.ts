import { createCheckoutSessionSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/**
 * NestJS DTO class for the checkout request body.
 *
 * The validation rules live in `createCheckoutSessionSchema` in shared-types;
 * this thin generated class is what NestJS needs as a `@Body()` metatype. The
 * global `ZodValidationPipe` (see `main.ts`) sees that this is a `ZodDto` and
 * validates the incoming body against the shared schema. There is nothing to
 * hand-maintain here — the class derives entirely from the shared schema, so it
 * cannot drift from it.
 */
export class CreateCheckoutSessionDto extends createZodDto(createCheckoutSessionSchema) {}
