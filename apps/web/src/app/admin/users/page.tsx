import { PlatformShell } from '../../../components/layout/platform-shell';
import { UsersPanel } from '../../../features/auth/users-panel';
export default function Page() {
  return (
    <PlatformShell>
      <UsersPanel />
    </PlatformShell>
  );
}
