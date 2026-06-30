import { Injectable } from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import { EmailTemplate, EmailTemplatePayload } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';

@Injectable()
export class EmailService {
  private readonly apiKey: string | undefined;
  private readonly from: { email: string; name: string };

  constructor(private readonly configService: ScratchConfigService) {
    this.apiKey = this.configService.getSendGridApiKey();
    this.from = { email: this.configService.getSendGridFromEmail(), name: 'Scratch' };

    if (this.apiKey) {
      sgMail.setApiKey(this.apiKey);
    } else {
      WSLogger.warn({
        source: 'EmailService',
        message: 'SendGrid API key is not configured',
      });
    }
  }

  private async sendTemplatedEmail<T extends EmailTemplate>(
    to: string,
    templateId: T,
    dynamicTemplateData: EmailTemplatePayload[T],
  ): Promise<void> {
    if (!this.apiKey) {
      return;
    }

    WSLogger.info({
      source: 'EmailService',
      message: `Sending email (template: ${templateId})`,
      data: { to, dynamicTemplateData },
    });
    try {
      await sgMail.send({
        to,
        from: this.from,
        templateId,
        dynamicTemplateData,
      });
    } catch (err) {
      WSLogger.error({
        source: 'EmailService',
        message: `Failed to send email (template: ${templateId})`,
        cause: err as Error,
      });
    }
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

  async sendTestEmail({
    to,
    templateId,
    dynamicTemplateData,
  }: {
    to: string;
    templateId: string;
    dynamicTemplateData: Record<string, string>;
  }): Promise<void> {
    if (!this.apiKey) {
      throw new Error('SendGrid API key is not configured');
    }

    WSLogger.info({
      source: 'EmailService',
      message: `Sending test email (template: ${templateId})`,
      data: { to, dynamicTemplateData },
    });

    // Bypass everything and go straight to the API.
    try {
      await sgMail.send({
        to,
        from: this.from,
        templateId,
        dynamicTemplateData,
      });
    } catch (err) {
      WSLogger.error({
        source: 'EmailService',
        message: `Failed to send test email (template: ${templateId})`,
        cause: err as Error,
      });
      throw err;
    }
  }
}
