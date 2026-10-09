import { PlatformShell } from '../../../components/layout/platform-shell';
import { TournamentCreate } from '../../../features/tournaments/tournament-create';
export default function Page() {
  return (
    <PlatformShell>
      <TournamentCreate />
    </PlatformShell>
  );
}
