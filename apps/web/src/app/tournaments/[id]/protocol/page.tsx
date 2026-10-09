import { DrawProtocol } from '../../../../features/draws/draw-protocol';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DrawProtocol tournamentId={id} />;
}
