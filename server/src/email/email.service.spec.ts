import { EmailTemplate } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { sleep } from 'src/util';
import { EmailTemplateService } from './email-template.service';
import { EMAIL_REPLY_TO, EMAIL_SENDER, EmailService, RESEND_RATE_LIMIT_RETRIES } from './email.service';

const mockSendEmailThroughResend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSendEmailThroughResend } })),
}));
jest.mock('src/util', () => ({ sleep: jest.fn().mockResolvedValue(undefined) }));
const mockLogError = jest.fn();
jest.mock('src/logger', () => ({
  WSLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: (...args: unknown[]) => {
      mockLogError(...args);
    },
    debug: jest.fn(),
  },
}));

const APP_URL = 'https://test.scratch.md';

function resendSuccess() {
  return { data: { id: 'email-id' }, error: null, headers: {} };
}

function resendError(name: string, statusCode: number, headers: Record<string, string> | null = {}) {
  return { data: null, error: { name, statusCode, message: `${name} message` }, headers };
}

function buildEmailService(resendApiKey: string | undefined): {
  emailService: EmailService;
  renderTemplate: jest.Mock;
} {
  const configService = {
    getResendApiKey: () => resendApiKey,
    getScratchApplicationUrl: () => APP_URL,
  } as unknown as ScratchConfigService;
  const renderTemplate = jest.fn().mockReturnValue({ subject: 'Rendered subject', html: '<p>Rendered html</p>' });
  const emailTemplateService = { render: renderTemplate } as unknown as EmailTemplateService;
  return { emailService: new EmailService(configService, emailTemplateService), renderTemplate };
}

describe('EmailService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('without a Resend API key', () => {
    it('skips every send', async () => {
      const { emailService } = buildEmailService(undefined);

      await emailService.sendWaitlistApproved({ to: 'user@example.com' });

      expect(mockSendEmailThroughResend).not.toHaveBeenCalled();
    });

    it('fails a test send', async () => {
      const { emailService } = buildEmailService(undefined);

      await expect(
        emailService.sendTestEmail({
          to: 'admin@example.com',
          template: EmailTemplate.WaitlistApproved,
          templateData: { loginUrl: APP_URL },
        }),
      ).rejects.toThrow('Resend API key is not configured');
    });
  });

  describe('with a Resend API key', () => {
    it('renders the template with the app URL and sends it from Scratch, with replies to support', async () => {
      const { emailService, renderTemplate } = buildEmailService('re_test_key');
      mockSendEmailThroughResend.mockResolvedValueOnce(resendSuccess());

      await emailService.sendWorkspaceInvite({ to: 'user@example.com', inviterName: 'Ryder', workspaceName: 'Site' });

      expect(renderTemplate).toHaveBeenCalledWith(EmailTemplate.WorkspaceInvite, {
        inviterName: 'Ryder',
        workspaceName: 'Site',
        loginUrl: APP_URL,
        appUrl: APP_URL,
      });
      expect(mockSendEmailThroughResend).toHaveBeenCalledWith({
        from: EMAIL_SENDER,
        replyTo: EMAIL_REPLY_TO,
        to: 'user@example.com',
        subject: 'Rendered subject',
        html: '<p>Rendered html</p>',
      });
    });

    it('logs a Resend error from a regular send without throwing', async () => {
      const { emailService } = buildEmailService('re_test_key');
      mockSendEmailThroughResend.mockResolvedValueOnce(resendError('validation_error', 422));

      await emailService.sendTrialExpired({ to: 'user@example.com', userName: 'Alex' });

      expect(mockSendEmailThroughResend).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        expect.objectContaining({ message: `Failed to send email (template: ${EmailTemplate.TrialExpired})` }),
      );
    });

    it('fails a test send on a Resend error', async () => {
      const { emailService } = buildEmailService('re_test_key');
      mockSendEmailThroughResend.mockResolvedValueOnce(resendError('invalid_from_address', 403));

      await expect(
        emailService.sendTestEmail({
          to: 'admin@example.com',
          template: EmailTemplate.WaitlistApproved,
          templateData: { loginUrl: APP_URL },
        }),
      ).rejects.toThrow('invalid_from_address');
    });

    it('waits the retry-after seconds when rate limited, then retries', async () => {
      const { emailService } = buildEmailService('re_test_key');
      mockSendEmailThroughResend
        .mockResolvedValueOnce(resendError('rate_limit_exceeded', 429, { 'retry-after': '2' }))
        .mockResolvedValueOnce(resendSuccess());

      await emailService.sendWaitlistApproved({ to: 'user@example.com' });

      expect(sleep).toHaveBeenCalledWith(2000);
      expect(mockSendEmailThroughResend).toHaveBeenCalledTimes(2);
      expect(mockLogError).not.toHaveBeenCalled();
    });

    it('waits one second when rate limited without a retry-after header', async () => {
      const { emailService } = buildEmailService('re_test_key');
      mockSendEmailThroughResend
        .mockResolvedValueOnce(resendError('rate_limit_exceeded', 429, null))
        .mockResolvedValueOnce(resendSuccess());

      await emailService.sendWaitlistApproved({ to: 'user@example.com' });

      expect(sleep).toHaveBeenCalledWith(1000);
      expect(mockSendEmailThroughResend).toHaveBeenCalledTimes(2);
    });

    it('gives up after the last rate-limit retry', async () => {
      const { emailService } = buildEmailService('re_test_key');
      mockSendEmailThroughResend.mockResolvedValue(resendError('rate_limit_exceeded', 429));

      await expect(
        emailService.sendTestEmail({
          to: 'admin@example.com',
          template: EmailTemplate.WaitlistApproved,
          templateData: { loginUrl: APP_URL },
        }),
      ).rejects.toThrow('rate_limit_exceeded');
      expect(mockSendEmailThroughResend).toHaveBeenCalledTimes(RESEND_RATE_LIMIT_RETRIES + 1);
      expect(sleep).toHaveBeenCalledTimes(RESEND_RATE_LIMIT_RETRIES);
    });

    it('does not retry when the monthly quota is used up', async () => {
      const { emailService } = buildEmailService('re_test_key');
      mockSendEmailThroughResend.mockResolvedValueOnce(resendError('monthly_quota_exceeded', 429));

      await emailService.sendWaitlistApproved({ to: 'user@example.com' });

      expect(mockSendEmailThroughResend).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(mockLogError).toHaveBeenCalled();
    });
  });
});
