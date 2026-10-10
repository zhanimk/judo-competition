/** Offline metadata is an atomic lease. Partial or legacy metadata remains owned
 * for review; no command may silently replace or reconcile its saved journal. */
type OfflineMetadata = {
  offlineSessionId?: string | null;
  offlineActorId?: string | null;
  offlineControlGeneration?: number | null;
};

export function hasOfflineOwnership(row: OfflineMetadata): boolean {
  return (
    row.offlineSessionId != null ||
    row.offlineActorId != null ||
    row.offlineControlGeneration != null
  );
}

export function hasIncompleteOfflineOwnership(row: OfflineMetadata): boolean {
  return (
    hasOfflineOwnership(row) &&
    !(
      typeof row.offlineSessionId === 'string' &&
      row.offlineSessionId.trim().length > 0 &&
      typeof row.offlineActorId === 'string' &&
      row.offlineActorId.trim().length > 0 &&
      typeof row.offlineControlGeneration === 'number' &&
      Number.isSafeInteger(row.offlineControlGeneration) &&
      row.offlineControlGeneration >= 0
    )
  );
}
