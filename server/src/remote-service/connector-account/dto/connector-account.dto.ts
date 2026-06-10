import { createConnectorAccountSchema, updateConnectorAccountSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge classes for the shared connector-account request schemas.
export class CreateConnectorAccountDto extends createZodDto(createConnectorAccountSchema) {}
export class UpdateConnectorAccountDto extends createZodDto(updateConnectorAccountSchema) {}
