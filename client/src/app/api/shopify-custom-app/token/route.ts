import { NextRequest, NextResponse } from 'next/server';

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
