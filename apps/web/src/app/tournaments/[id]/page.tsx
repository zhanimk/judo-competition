import { PlatformShell } from '../../../components/layout/platform-shell';
import { TournamentWorkspace } from '../../../features/tournaments/tournament-workspace';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PlatformShell>
      <TournamentWorkspace id={id} />
    </PlatformShell>
  );
}
