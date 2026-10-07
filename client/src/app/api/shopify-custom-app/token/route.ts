import { NextRequest, NextResponse } from 'next/server';
import { isValidMyshopifyShopDomain } from './is-valid-myshopify-shop-domain';

interface ShopifyTokenRequest {
  code: string;
  shop: string;
  client_id: string;
  client_secret: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as Partial<ShopifyTokenRequest>;
  const { code, shop, client_id, client_secret } = body;

  if (!code || !shop || !client_id || !client_secret) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // This route is unauthenticated and posts the user's client secret to `shop`, so only ever send it to a
  // real <store>.myshopify.com host — never to whatever host a crafted link puts in `shop`.
  if (!isValidMyshopifyShopDomain(shop)) {
    return NextResponse.json(
      { error: `"${shop}" isn't a valid <store>.myshopify.com domain, so your secret was not sent anywhere` },
      { status: 400 },
    );
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id, client_secret, code }),
  });

  const data = (await response.json()) as Record<string, unknown>;

  if (!response.ok) {
    return NextResponse.json(data, { status: response.status });
  }

  return NextResponse.json(data);
}
