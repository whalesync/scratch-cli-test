/**
 * The static outbound IP of Scratch's production servers (the europe-west1 Cloud NAT address,
 * `terraform output nat_egress_ip` in `terraform/envs/eu-production`). Customer databases see every connection,
 * Live Export runs included, coming from it. Scratch's test environment leaves from a different address, so its
 * messages name the production one.
 */
export const SCRATCH_PRODUCTION_EGRESS_IP_ADDRESS = '35.233.96.253';

/**
 * How users should describe Scratch's network address when allowlisting it: every message that tells users to
 * allowlist Scratch (the MySQL and Postgres connectors' help text and connection errors) goes through here. It names
 * the address and not the product, because Whalesync's Live Export shows the same messages to its users.
 */
export function describeScratchNetworkAddressForAllowlisting(): string {
  return `the IP address ${SCRATCH_PRODUCTION_EGRESS_IP_ADDRESS}`;
}
