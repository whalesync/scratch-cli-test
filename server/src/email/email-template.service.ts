import { Injectable, OnModuleInit } from '@nestjs/common';
import { EmailTemplate } from '@spinner/shared-types';
import * as fs from 'fs';
import Handlebars from 'handlebars';
import * as path from 'path';
import { WSLogger } from 'src/logger';
import { assertUnreachable } from 'src/utils/asserts';

/** The subject line of each email, rendered with the same fields as its body. */
export function getEmailTemplateSubject(template: EmailTemplate): string {
  switch (template) {
    case EmailTemplate.WorkspaceInvite:
      return 'Scratch invitation from {{inviterName}}';
    case EmailTemplate.InviteAccepted:
      return 'Invite accepted by {{acceptedByName}}';
    case EmailTemplate.WaitlistApproved:
      return 'Welcome to Scratch!';
    case EmailTemplate.TrialEndingSoon:
      return 'Your Scratch trial ends in {{daysRemaining}} days';
    case EmailTemplate.TrialExpired:
      return 'Your Scratch trial has ended';
    default:
      return assertUnreachable(template);
  }
}

/**
 * Finds the MJML templates, which `nest-cli.json` copies to `dist/email/templates/`. The Docker build compiles `src/`
 * flat into `dist/`, so they sit next to this file. A local build nests the output under `dist/src/` (the server root has
 * `.ts` files of its own), so they are two levels up. Under jest this file runs from `src/`, next to them again.
 */
function findEmailTemplatesDirectory(): string {
  const candidateTemplateDirectories = [
    path.join(__dirname, 'templates'),
    path.join(__dirname, '..', '..', 'email', 'templates'),
  ];
  const emailTemplatesDirectory = candidateTemplateDirectories.find((directory) => fs.existsSync(directory));
  if (!emailTemplatesDirectory) {
    throw new Error(`Email templates not found in ${candidateTemplateDirectories.join(' or ')}`);
  }
  return emailTemplatesDirectory;
}

type CompiledEmailTemplate = {
  renderSubject: HandlebarsTemplateDelegate;
  renderHtml: HandlebarsTemplateDelegate;
};

/**
 * Compiles the MJML email templates in `./templates/` to HTML at startup and renders them with Handlebars at send
 * time, so the copy lives in the repo instead of in the email provider's hosted editor.
 *
 * Every template includes `partials/attributes.mjml` for the shared styles and `partials/header.mjml` for the logo.
 * The header loads the logo from the web app (`{{appUrl}}/email/scratch-logo.png`), so every render needs `appUrl`.
 *
 * Rendering is strict: a field the template uses but the data lacks throws instead of rendering blank.
 */
@Injectable()
export class EmailTemplateService implements OnModuleInit {
  private readonly compiledTemplateByName = new Map<EmailTemplate, CompiledEmailTemplate>();

  async onModuleInit(): Promise<void> {
    const emailTemplatesDirectory = findEmailTemplatesDirectory();
    for (const template of Object.values(EmailTemplate)) {
      await this.compileTemplate(emailTemplatesDirectory, template);
    }
  }

  render(template: EmailTemplate, templateData: Record<string, string>): { subject: string; html: string } {
    const compiledTemplate = this.compiledTemplateByName.get(template);
    if (!compiledTemplate) {
      throw new Error(`Email template ${template} was not compiled`);
    }
    return {
      subject: compiledTemplate.renderSubject(templateData),
      html: compiledTemplate.renderHtml(templateData),
    };
  }

  private async compileTemplate(emailTemplatesDirectory: string, template: EmailTemplate): Promise<void> {
    // Loaded lazily: mjml holds references that keep every jest sandbox importing this file (via EmailService) alive,
    // so it must stay out of the module-level import graph. It's a `require` because under NodeNext a dynamic `import()`
    // stays a native import, which jest can't run.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mjml2html = require('mjml') as typeof import('mjml');
    const mjmlPath = path.join(emailTemplatesDirectory, `${template}.mjml`);
    const mjmlSource = fs.readFileSync(mjmlPath, 'utf-8');
    // MJML 5 ignores `mj-include` unless told otherwise, and resolves includes relative to `filePath`.
    const mjmlResult = await mjml2html(mjmlSource, {
      validationLevel: 'strict',
      ignoreIncludes: false,
      filePath: mjmlPath,
    });
    if (mjmlResult.errors.length > 0) {
      const errorMessages = mjmlResult.errors.map((error) => error.formattedMessage ?? error.message).join('; ');
      throw new Error(`MJML compile errors for ${template}: ${errorMessages}`);
    }
    this.compiledTemplateByName.set(template, {
      // Subjects are plain text, so they must not be HTML-escaped ("R&D" would otherwise arrive as "R&amp;D").
      renderSubject: Handlebars.compile(getEmailTemplateSubject(template), { strict: true, noEscape: true }),
      renderHtml: Handlebars.compile(mjmlResult.html, { strict: true }),
    });
    WSLogger.info({ source: 'EmailTemplateService', message: `Compiled email template ${template}` });
  }
}
