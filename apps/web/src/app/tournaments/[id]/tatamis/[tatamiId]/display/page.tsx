import { TatamiPanel } from '../../../../../../features/tatamis/tatami-panel';
import '../../../../../../components/layout/platform.css';
import '../../../../../../features/tatamis/tatami-display.css';
export default async function Page({
  params,
}: {
  params: Promise<{ id: string; tatamiId: string }>;
}) {
  const { id, tatamiId } = await params;
  return (
    <div className="platform tatami-display-page">
      <TatamiPanel tournamentId={id} tatamiId={tatamiId} display />
    </div>
  );
}
