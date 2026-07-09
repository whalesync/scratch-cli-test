import { UserCluster } from 'src/db/cluster-types';

export class SlackFormatters {
  private constructor() {}

  /**
   * Formats a link in Slack markdown format, which is not the same as the regularl []() format.
   * @param label label for the link
   * @param url the url for the link
   * @returns Encoded link in Slack mkdn format
   */
  static formatLink(label: string, url: string): string {
    return `<${url}|${label}>`;
  }

  static newUserSignup(user: UserCluster.User, offerCode?: string): string {
    return `👤 New user signup: ${user.email || user.name || 'no email'} (${user.id}) ${offerCode ? `with offer code ${offerCode}` : ''}`;
  }

  static userIdentifier(user: UserCluster.User, emoji: string = '👤', includeId: boolean = false): string {
    return `${emoji} ${user.email ?? user.name ?? user.id} ${includeId ? `(${user.id})` : ''}`;
  }

  static waitlistAccessRequest(user: UserCluster.User, approveUrl: string): string {
    const userInfo = user.email || user.name || user.id;
    const link = SlackFormatters.formatLink('Approve in Dev Tools', approveUrl);
    return `🙋 *Waitlist Access Request*\n👤 ${userInfo} (${user.id})\n🔗 ${link}`;
  }

  static waitlistUserApproved(user: UserCluster.User, approvedBy: UserCluster.User): string {
    const userInfo = user.email || user.name || user.id;
    const adminInfo = approvedBy.email || approvedBy.name || approvedBy.id;
    return `✅ *Waitlist Approved*\n👤 ${userInfo} was approved by ${adminInfo}`;
  }

  static whalesyncAccountLinked(user: UserCluster.User, whalesyncUserId: string): string {
    const userInfo = user.email || user.name || user.id;
    return `🔗 *Whalesync account linked*\n👤 ${userInfo} (${user.id})\n🐳 Whalesync user: ${whalesyncUserId}`;
  }

  static clerkAccountLinked(user: UserCluster.User, clerkId: string): string {
    const userInfo = user.email || user.name || user.id;
    return `🔗 *Native Clerk sign-in linked to shadow user*\n👤 ${userInfo} (${user.id})\n🔑 Clerk id: ${clerkId}`;
  }
}
