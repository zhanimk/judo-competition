import { PlatformShell } from '../../../../../components/layout/platform-shell';
import { TatamiPanel } from '../../../../../features/tatamis/tatami-panel';
export default async function Page({
  params,
}: {
  params: Promise<{ id: string; tatamiId: string }>;
}) {
  const { id, tatamiId } = await params;
  return (
    <PlatformShell>
      <TatamiPanel tournamentId={id} tatamiId={tatamiId} />
    </PlatformShell>
  );
}
