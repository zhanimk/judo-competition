import { PlatformShell } from '../../../../components/layout/platform-shell';
import { ControlCenter } from '../../../../features/control/control-center';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <PlatformShell>
      <ControlCenter tournamentId={id} />
    </PlatformShell>
  );
}
