import { OperatorPanel } from '../../../features/auth/operator-panel';
export default async function Page({ params }: { params: Promise<{ tatamiId: string }> }) {
  return <OperatorPanel tatamiId={(await params).tatamiId} />;
}
