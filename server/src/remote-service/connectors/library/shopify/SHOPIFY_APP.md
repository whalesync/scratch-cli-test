# Shopify App Configuration

## Environment Variables

Both values come from the app's **Client credentials** section in the Shopify app dashboard (under "Configuration" > "Client credentials"):

| Variable | Description |
|----------|-------------|
| `SHOPIFY_CLIENT_ID` | OAuth client ID, used for the OAuth authorization flow |
| `SHOPIFY_CLIENT_SECRET` | OAuth client secret, used for OAuth token exchange and HMAC webhook signature verification |

Each environment (test/prod) has its own app with its own credentials.

## Dashboard Links

| Environment | App Dashboard | App Store Listing |
|-------------|--------------|-------------------|
| Test | [Test App](https://dev.shopify.com/dashboard/205560593/apps/331011489793) | — |
| Production | [Prod App](https://dev.shopify.com/dashboard/205560593/apps/331007164417) | [App Store](https://partners.shopify.com/4746333/apps/331007164417/overview) |

## Configuring GDPR Compliance Webhooks

Shopify requires three mandatory compliance webhook endpoints for app store submission:

- `customers/data_request` — Shopify asks if we store customer data
- `customers/redact` — Shopify asks us to delete customer data
- `shop/redact` — Shopify asks us to delete all shop data (48h after uninstall)

All three are handled by a single endpoint: `POST /shopify/webhooks`, which dispatches based on the `X-Shopify-Topic` header.

### Setup Steps

The Shopify CLI requires a `package.json` in the working directory. If you don't have one, create it first:

```bash
npm init -y
```

1. **Pull the app config** (if you haven't already):

   ```bash
   shopify app config link
   ```

   This creates a `shopify.app.toml` file locally.

2. **Add the webhook subscriptions** to `shopify.app.toml`:

   ```toml
   [webhooks]
   api_version = "2024-07"

   [[webhooks.subscriptions]]
   compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
   uri = "https://api.scratch.so/shopify/webhooks"
   ```

3. **Deploy the config**:

   ```bash
   shopify app deploy
   ```

   This pushes the webhook configuration to the Shopify Partner Dashboard.

> **Note:** The compliance webhook URL fields are no longer available in the Partner Dashboard UI. The `shopify.app.toml` config file is the only way to configure them.

## App Settings

- **Embedded app**: Must be set to **false**. Scratch is a standalone app, not embedded in the Shopify admin iframe.
