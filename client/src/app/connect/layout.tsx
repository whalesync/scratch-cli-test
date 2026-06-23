/**
 * Standalone layout for the marketplace-initiated ("inbound") OAuth claim pages (`/connect/...`).
 * Renders children directly — no workbook app shell — since the user arrives here mid-install,
 * before any workbook is selected. Mirrors `app/oauth/layout.tsx`.
 */
export default function ConnectLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
