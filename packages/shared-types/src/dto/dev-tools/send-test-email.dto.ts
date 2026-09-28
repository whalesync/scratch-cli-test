import { z } from 'zod';
import { EMAIL_TEMPLATE_PAYLOADS, EmailTemplate } from '../../email';

/**
 * Body for the admin email tester (`POST /dev-tools/email/send-test`): renders one of Scratch's email templates with
 * the given fields and sends it to `to`. Every field the template expects must be present, so a missing field is a
 * 400 here rather than a render error inside the send.
 */
export const sendTestEmailSchema = z
  .object({
    template: z.enum(EmailTemplate),
    to: z.email(),
    templateData: z.record(z.string(), z.string()),
  })
  .superRefine((body, ctx) => {
    for (const field of EMAIL_TEMPLATE_PAYLOADS[body.template]) {
      if (body.templateData[field] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['templateData', field],
          message: `${field} is required for the ${body.template} template`,
        });
      }
    }
  });

export type SendTestEmailDto = z.infer<typeof sendTestEmailSchema>;
