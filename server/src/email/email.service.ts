import { Injectable } from '@nestjs/common';
import { EmailTemplate, EmailTemplatePayload } from '@spinner/shared-types';
import { Resend } from 'resend';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { sleep } from 'src/util';
import { EmailTemplateService } from './email-template.service';

/**
 * The sender has to be on a domain Resend has verified, and only `updates.scratch.md` is. Mail sent to that subdomain
 * goes to Resend's inbound service, which nothing of ours reads, so replies go to support instead.
 */
export const EMAIL_SENDER = 'Scratch <notifications@updates.scratch.md>';
export const EMAIL_REPLY_TO = 'support@scratch.md';

/** How many times to retry a send that Resend turned away for exceeding its rate limit. */
export const RESEND_RATE_LIMIT_RETRIES = 3;

@Injectable()
export class EmailService {
  /** Unset when there is no API key (e.g. local dev): every send is then skipped. */
  private readonly resendClientIfConfigured: Resend | undefined;

  constructor(
    private readonly configService: ScratchConfigService,
    private readonly emailTemplateService: EmailTemplateService,
  ) {
    const resendApiKey = this.configService.getResendApiKey();
    // `new Resend()` throws on an empty key, so only construct it when there is one.
    if (resendApiKey) {
      this.resendClientIfConfigured = new Resend(resendApiKey);
    } else {
      WSLogger.warn({
        source: 'EmailService',
        message: 'Resend API key is not configured, so no email will be sent',
      });
    }
  }

  private async sendTemplatedEmail<T extends EmailTemplate>(
    to: string,
    template: T,
    templateData: EmailTemplatePayload[T],
  ): Promise<void> {
    if (!this.resendClientIfConfigured) {
      return;
    }

    WSLogger.info({
      source: 'EmailService',
      message: `Sending email (template: ${template})`,
      data: { to, templateData },
    });
    try {
      await this.renderAndSendWithResend(this.resendClientIfConfigured, to, template, templateData);
    } catch (err) {
      WSLogger.error({
        source: 'EmailService',
        message: `Failed to send email (template: ${template})`,
        cause: err as Error,
      });
    }
  }

  /**
   * The Resend SDK reports failures in its return value instead of throwing, so this checks `error` and throws. A send
   * turned away for exceeding Resend's rate limit, which Whalesync shares, waits as long as Resend asks and tries
   * again. Every other error, including the monthly quota, fails immediately.
   */
  private async renderAndSendWithResend(
    resendClient: Resend,
    to: string,
    template: EmailTemplate,
    templateData: Record<string, string>,
  ): Promise<void> {
    const { subject, html } = this.emailTemplateService.render(template, {
      ...templateData,
      appUrl: this.configService.getScratchApplicationUrl(),
    });
    for (let rateLimitRetriesSoFar = 0; ; rateLimitRetriesSoFar++) {
      const { error, headers } = await resendClient.emails.send({
        from: EMAIL_SENDER,
        replyTo: EMAIL_REPLY_TO,
        to,
        subject,
        html,
      });
      if (error === null) {
        return;
      }
      if (error.name === 'rate_limit_exceeded' && rateLimitRetriesSoFar < RESEND_RATE_LIMIT_RETRIES) {
        await this.waitForResendRateLimit(headers);
        continue;
      }
      throw new Error(`Resend rejected the email: ${error.name} (status ${error.statusCode}): ${error.message}`);
    }
  }

  /** Waits the number of seconds in Resend's `retry-after` header, or one second when it is missing. */
  private async waitForResendRateLimit(responseHeaders: Record<string, string> | null): Promise<void> {
    const retryAfterSeconds = Number(responseHeaders?.['retry-after']);
    await sleep(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 1000);
  }

  async sendWorkspaceInvite({
    to,
    inviterName,
    workspaceName,
  }: {
    to: string;
    inviterName: string;
    workspaceName: string;
  }): Promise<void> {
    await this.sendTemplatedEmail(to, EmailTemplate.WorkspaceInvite, {
      inviterName,
      workspaceName,
      loginUrl: this.configService.getScratchApplicationUrl(),
    });
  }

  async sendInviteAccepted({
    to,
    acceptedByName,
    workspaceName,
  }: {
    to: string;
    acceptedByName: string;
    workspaceName: string;
  }): Promise<void> {
    await this.sendTemplatedEmail(to, EmailTemplate.InviteAccepted, {
      acceptedByName,
      workspaceName,
      workspaceUrl: this.configService.getScratchApplicationUrl(),
    });
  }

  async sendWaitlistApproved({ to }: { to: string }): Promise<void> {
    await this.sendTemplatedEmail(to, EmailTemplate.WaitlistApproved, {
      loginUrl: this.configService.getScratchApplicationUrl(),
    });
  }

  /**
   * DEV-10573: "~N days remaining" reminder, sent off the Stripe `customer.subscription.trial_will_end`
   * webhook so a trialing user is prompted to add a payment method before their Pro trial ends. The
   * `upgradeUrl` deep-links to the billing page so the user can add a payment method directly.
   */
  async sendTrialEndingSoon({
    to,
    userName,
    daysRemaining,
  }: {
    to: string;
    userName: string;
    daysRemaining: number;
  }): Promise<void> {
    await this.sendTemplatedEmail(to, EmailTemplate.TrialEndingSoon, {
      userName,
      daysRemaining: String(daysRemaining),
      upgradeUrl: `${this.configService.getScratchApplicationUrl()}/billing`,
    });
  }

  /**
   * DEV-10573: post-expiry notice, sent when a Pro trial ends without a payment method and the account
   * has been downgraded to Free (the `trialing -> canceled` transition). The `resubscribeUrl` deep-links
   * to the billing page so the user can re-subscribe directly.
   */
  async sendTrialExpired({ to, userName }: { to: string; userName: string }): Promise<void> {
    await this.sendTemplatedEmail(to, EmailTemplate.TrialExpired, {
      userName,
      resubscribeUrl: `${this.configService.getScratchApplicationUrl()}/billing`,
    });
  }

  /** For the admin email tester: sends one template with the given fields, and throws when the send fails. */
  async sendTestEmail({
    to,
    template,
    templateData,
  }: {
    to: string;
    template: EmailTemplate;
    templateData: Record<string, string>;
  }): Promise<void> {
    if (!this.resendClientIfConfigured) {
      throw new Error('Resend API key is not configured');
    }

    WSLogger.info({
      source: 'EmailService',
      message: `Sending test email (template: ${template})`,
      data: { to, templateData },
    });
    try {
      await this.renderAndSendWithResend(this.resendClientIfConfigured, to, template, templateData);
    } catch (err) {
      WSLogger.error({
        source: 'EmailService',
        message: `Failed to send test email (template: ${template})`,
        cause: err as Error,
      });
      throw err;
    }
  }
}
