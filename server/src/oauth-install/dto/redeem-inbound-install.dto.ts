import { redeemInboundInstallSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';

// NestJS bridge class for the shared inbound-install redeem request schema. The
// global ZodValidationPipe validates the incoming body against the shared schema.
export class RedeemInboundInstallDtoClass extends createZodDto(redeemInboundInstallSchema) {}
