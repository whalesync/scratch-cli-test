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
