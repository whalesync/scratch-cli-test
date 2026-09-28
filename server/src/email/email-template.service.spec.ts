import { EMAIL_TEMPLATE_PAYLOADS, EmailTemplate } from '@spinner/shared-types';
import { EmailTemplateService } from './email-template.service';

jest.mock('src/logger', () => ({
  WSLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const APP_URL = 'https://app.example.test';

/** A distinct value for every field the template expects, so each one can be found in the output. */
function buildSampleTemplateData(template: EmailTemplate): Record<string, string> {
  const templateData: Record<string, string> = { appUrl: APP_URL };
  for (const field of EMAIL_TEMPLATE_PAYLOADS[template]) {
    templateData[field] = field.endsWith('Url') ? `https://links.example.test/${field}` : `sample-${field}`;
  }
  return templateData;
}

describe('EmailTemplateService', () => {
  let emailTemplateService: EmailTemplateService;

  beforeAll(async () => {
    emailTemplateService = new EmailTemplateService();
    await emailTemplateService.onModuleInit();
  });

  describe.each(Object.values(EmailTemplate))('%s', (template) => {
    it('uses every field it is given and leaves no placeholders behind', () => {
      const templateData = buildSampleTemplateData(template);
      const { subject, html } = emailTemplateService.render(template, templateData);

      for (const field of EMAIL_TEMPLATE_PAYLOADS[template]) {
        expect(html).toContain(templateData[field]);
      }
      expect(subject).not.toContain('{{');
      expect(html).not.toContain('{{');
    });

    it('loads the logo from the app it was sent from and links nowhere else in Scratch', () => {
      const { html } = emailTemplateService.render(template, buildSampleTemplateData(template));

      expect(html).toContain(`src="${APP_URL}/email/scratch-logo.png"`);
      expect(html).not.toContain('app.scratch.md');
    });

    it('has nothing left from SendGrid', () => {
      const { html } = emailTemplateService.render(template, buildSampleTemplateData(template));

      expect(html.toLowerCase()).not.toContain('sendgrid');
      expect(html.toLowerCase()).not.toContain('unsubscribe');
    });

    it('throws instead of rendering a missing field blank', () => {
      const templateDataWithoutFirstField = buildSampleTemplateData(template);
      delete templateDataWithoutFirstField[EMAIL_TEMPLATE_PAYLOADS[template][0]];

      expect(() => emailTemplateService.render(template, templateDataWithoutFirstField)).toThrow();
    });
  });

  it('escapes fields in the body but not in the subject', () => {
    const { subject, html } = emailTemplateService.render(EmailTemplate.WorkspaceInvite, {
      ...buildSampleTemplateData(EmailTemplate.WorkspaceInvite),
      inviterName: 'Tom & <b>Jerry</b>',
    });

    expect(subject).toBe('Scratch invitation from Tom & <b>Jerry</b>');
    expect(html).toContain('Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;');
  });

  it('previews the trial reminder as a trial reminder', () => {
    const { html } = emailTemplateService.render(
      EmailTemplate.TrialEndingSoon,
      buildSampleTemplateData(EmailTemplate.TrialEndingSoon),
    );

    expect(html).toContain('Your Scratch trial ends in sample-daysRemaining days');
    expect(html.toLowerCase()).not.toContain('waitlist');
  });
});
