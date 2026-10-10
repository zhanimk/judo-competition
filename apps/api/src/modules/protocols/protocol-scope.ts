import { ConflictException } from '@nestjs/common';
import type { ProtocolKind } from './protocol-model.js';

/** Called after validating every requested category ID in a consistent snapshot.
 * Empty saved configurations have no draw to publish; participant lists retain them. */
export function protocolScope<
  T extends { entries: readonly unknown[]; draw: { status: string } | null },
>(categories: readonly T[], kind: ProtocolKind) {
  if (kind !== 'DRAW' && kind !== 'TEAMS') return categories;
  const active = categories.filter((category) => category.entries.length > 0);
  if (!active.length) throw new ConflictException('NO_ACTIVE_CATEGORIES');
  if (kind === 'DRAW' && active.some((category) => category.draw?.status === 'STALE'))
    throw new ConflictException('DRAW_ENTRIES_CHANGED');
  return active;
}
