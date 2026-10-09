import { PlatformShell } from '../../components/layout/platform-shell';
import { TournamentList } from '../../features/tournaments/tournament-list';
export default function Page() {
  return (
    <PlatformShell>
      <TournamentList />
    </PlatformShell>
  );
}
