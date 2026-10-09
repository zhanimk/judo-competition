import { TatamiPanel } from '../../../../../../features/tatamis/tatami-panel';
import '../../../../../../components/layout/platform.css';
export default async function Page({
  params,
}: {
  params: Promise<{ id: string; tatamiId: string }>;
}) {
  const { id, tatamiId } = await params;
  return (
    <div className="platform">
      <div className="platform-content" style={{ width: '100%' }}>
        <TatamiPanel tournamentId={id} tatamiId={tatamiId} display />
      </div>
    </div>
  );
}
