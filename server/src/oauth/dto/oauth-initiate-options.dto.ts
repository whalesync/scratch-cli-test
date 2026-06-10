import { oauthInitiateOptionsSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge class for the shared OAuth initiate-options request schema.
export class OAuthInitiateOptionsDto extends createZodDto(oauthInitiateOptionsSchema) {}
