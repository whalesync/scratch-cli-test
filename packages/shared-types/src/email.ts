/**
 * Scratch's email templates. Each value is the name of the template's MJML file in `server/src/email/templates/`.
 */
export enum EmailTemplate {
  WorkspaceInvite = 'workspace-invite',
  InviteAccepted = 'invite-accepted',
  WaitlistApproved = 'waitlist-approved',
  TrialEndingSoon = 'trial-ending-soon',
  TrialExpired = 'trial-expired',
}

/** The fields expected for each template. Force the callers to provide it. */
export const EMAIL_TEMPLATE_PAYLOADS = {
  [EmailTemplate.WorkspaceInvite]: ['inviterName', 'workspaceName', 'loginUrl'],
  [EmailTemplate.InviteAccepted]: ['acceptedByName', 'workspaceName', 'workspaceUrl'],
  [EmailTemplate.WaitlistApproved]: ['loginUrl'],
  [EmailTemplate.TrialEndingSoon]: ['userName', 'daysRemaining', 'upgradeUrl'],
  [EmailTemplate.TrialExpired]: ['userName', 'resubscribeUrl'],
} as const satisfies Record<EmailTemplate, readonly string[]>;

export type EmailTemplatePayload = {
  [K in EmailTemplate]: Record<(typeof EMAIL_TEMPLATE_PAYLOADS)[K][number], string>;
};
