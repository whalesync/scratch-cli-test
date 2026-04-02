import { redirect } from 'next/navigation';

export default async function WorkspaceConnectionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/workbook/${id}/files`);
}
