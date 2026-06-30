/**
 * SendGrid dynamic template IDs.
 */
export enum EmailTemplate {
  WorkspaceInvite = 'd-d62ed43be3b64fb6b30d69cd3a1f3495',
  InviteAccepted = 'd-90e62f0837604ce782d130497c866d31',
  WaitlistApproved = 'd-58ff7ed006e3405ab0e71c0180fda91c',
  TrialEndingSoon = 'd-7e18057de95d4cb5bdf10bff8e0cd322',
  TrialExpired = 'd-527f659a9d824b2b940f2df3d3c87345',
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
