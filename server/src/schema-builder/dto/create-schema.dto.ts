import { createSchemaFieldsSchema, createSchemaTablesSchema, generateCreatePlanSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

/**
 * NestJS bridge classes for the shared create-schema request schemas. The global
 * ZodValidationPipe validates an incoming body against the schema; the generated
 * class can't drift from the shared contract. (The /schema/validate endpoint
 * deliberately takes a raw `unknown` body — not one of these — so it can collect
 * issues instead of throwing.)
 */
export class CreateSchemaTablesDto extends createZodDto(createSchemaTablesSchema) {}
export class CreateSchemaFieldsDto extends createZodDto(createSchemaFieldsSchema) {}
export class GenerateCreatePlanDto extends createZodDto(generateCreatePlanSchema) {}
