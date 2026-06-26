import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  InternalServerErrorException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CreateCheckoutSessionResponse, CreateCustomerPortalUrlResponse } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { isErr } from 'src/types/results';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CreatePortalDto } from './dto/create-portal.dto';
import { getPlan, getPlanTypeFromString } from './plans';
import { StripePaymentService } from './stripe-payment.service';

const STRIPE_PAGE_ERROR_USER_FACING_MESSAGE =
  'There was a problem navigating to the payment page. Please contact support.';

@Controller('payment')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class StripePaymentController {
  constructor(
    private readonly stripePaymentService: StripePaymentService,
    private readonly configService: ScratchConfigService,
  ) {}

  /**
   * Called by an authenticated user to get a link to their stripe page portal page.
   * This page is for managing their existing subscriptions.
   * Returns a URL that the user should be redirected to.
   */
  @Post('portal')
  async createCustomerPortalUrl(
    @Req() req: RequestWithUser,
    @Body() dto: CreatePortalDto,
  ): Promise<CreateCustomerPortalUrlResponse> {
    if (!req.user) {
      throw new UnauthorizedException();
    }

    const result = await this.stripePaymentService.createCustomerPortalUrl(req.user, dto);
    if (isErr(result)) {
      throw new InternalServerErrorException({
        userFacingMessage: STRIPE_PAGE_ERROR_USER_FACING_MESSAGE,
      });
    }
    return { url: result.v };
  }

  /**
   * Called by an authenticated user to start a checkout session for them with stripe.
   * Returns a URL that the user should be redirected to.
   */
  @Post('checkout/:planType')
  async createCheckoutSession(
    @Req() req: RequestWithUser,
    @Param('planType') planType: string,
    @Body() dto: CreateCheckoutSessionDto,
  ): Promise<CreateCheckoutSessionResponse> {
    if (!req.user) {
      throw new UnauthorizedException();
    }

    const planTypeEnum = getPlanTypeFromString(planType);

    // TODO validate the product type enum
    if (!planTypeEnum) {
      throw new BadRequestException({
        userFacingMessage: `Invalid product type: ${planType}`,
      });
    }

    // Internal plans (e.g. the Whalesync plan) are hidden from the pricing UI and cannot be purchased.
    // Reject with a clear 400 rather than letting checkout fail deep in Stripe with an opaque 500.
    if (getPlan(planTypeEnum)?.hidden) {
      throw new BadRequestException({
        userFacingMessage: 'This plan cannot be purchased.',
      });
    }

    const result = await this.stripePaymentService.generateCheckoutUrl(
      req.user,
      planTypeEnum,
      false,
      dto.returnPath,
      dto.cancelPath,
    );
    if (isErr(result)) {
      throw new InternalServerErrorException({
        userFacingMessage: STRIPE_PAGE_ERROR_USER_FACING_MESSAGE,
        debugMessage: `Encountered a problem generating stripe checkout URL: ${result.error}`,
      });
    }
    return { url: result.v };
  }
}
