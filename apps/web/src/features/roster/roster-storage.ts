import { blankRow, type DraftRow } from './roster-model.ts';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const draftKey = (tournamentId: string, clubId: string) =>
  `judo.roster.draft.${tournamentId}.${clubId}`;
export const selectionKey = (tournamentId: string) => `judo.roster.selected.${tournamentId}`;
export function readRosterPaste(store: Store, tournamentId: string, clubId: string): string {
  return store.getItem(`${draftKey(tournamentId, clubId)}.paste`) ?? '';
}
export function saveRosterPaste(
  store: Store,
  tournamentId: string,
  clubId: string,
  text: string,
): void {
  store.setItem(`${draftKey(tournamentId, clubId)}.paste`, text);
}
export function validDraftRows(value: unknown): value is DraftRow[] {
  if (!Array.isArray(value) || value.length > 500) return false;
  const ids = new Set<string>();
  return value.every((row) => {
    if (!row || typeof row.localId !== 'string' || !row.localId || ids.has(row.localId))
      return false;
    ids.add(row.localId);
    return (
      ['lastName', 'firstName', 'birthYear', 'categoryId'].every(
        (key) => typeof row[key] === 'string',
      ) &&
      ['', 'MALE', 'FEMALE'].includes(row.gender) &&
      (row.duplicateConfirmed === undefined || typeof row.duplicateConfirmed === 'boolean')
    );
  });
}
export function readRosterDraft(store: Store, tournamentId: string, clubId: string): DraftRow[] {
  const raw = store.getItem(draftKey(tournamentId, clubId));
  if (!raw) return [blankRow()];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('ROSTER_STORAGE_INVALID');
  }
  if (!validDraftRows(value)) throw new Error('ROSTER_STORAGE_INVALID');
  return value.length ? value : [blankRow()];
}
export function saveRosterDraft(
  store: Store,
  tournamentId: string,
  clubId: string,
  rows: DraftRow[],
): void {
  if (!validDraftRows(rows)) throw new Error('ROSTER_STORAGE_INVALID');
  store.setItem(draftKey(tournamentId, clubId), JSON.stringify(rows));
}
