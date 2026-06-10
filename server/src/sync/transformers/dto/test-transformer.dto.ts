import { testTransformerSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge class for the shared test-transformer request schema. The global
// ZodValidationPipe validates the incoming body against the shared zod schema.
export class TestTransformerDto extends createZodDto(testTransformerSchema) {}
