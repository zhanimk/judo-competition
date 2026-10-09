import type { Category, Entry } from '../tournaments/types';
import {
  validSavedEntry,
  validEntryCorrectionPreview,
  type DraftRow,
  type SavedEntry,
  type EntryCorrectionPreview,
} from './roster-model.ts';

export type CorrectionMode = 'update' | 'archive' | 'restore';

export function savedEntry(entry: Entry, category: Category): SavedEntry | null {
  const normalized = {
    ...entry,
    categoryId: category.id,
    clubId: entry.clubId ?? null,
    birthYear: entry.birthYear ?? null,
    gender:
      entry.gender ??
      (category.gender === 'MALE' || category.gender === 'FEMALE' ? category.gender : null),
    archivedAt: entry.archivedAt ?? null,
  };
  return validSavedEntry(normalized) ? normalized : null;
}

export function correctionRow(entry: SavedEntry): DraftRow {
  return {
    localId: entry.id,
    firstName: entry.firstName,
    lastName: entry.lastName,
    birthYear: String(entry.birthYear ?? ''),
    gender: entry.gender ?? '',
    categoryId: entry.categoryId,
    duplicateConfirmed: false,
  };
}

/** A reason change also requires a new explicit approval of the preview. */
export function correctionSignature(
  clubId: string,
  row: DraftRow,
  reason: string,
  revision: number,
): string {
  return JSON.stringify([clubId, row, reason, revision]);
}

const cleanName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');

/** Bind a server preview to the one entry and exact fields the administrator reviewed. */
export function correctionPreviewMatches(
  preview: EntryCorrectionPreview,
  entry: SavedEntry,
  clubId: string,
  row: DraftRow,
  mode: 'update' | 'restore',
  categoryGender?: string,
): boolean {
  if (
    !validEntryCorrectionPreview(preview) ||
    preview.before.id !== entry.id ||
    preview.before.athleteId !== preview.proposed.athleteId ||
    preview.proposed.archivedAt !== null
  )
    return false;
  const proposed = preview.proposed;
  if (
    proposed.clubId !== clubId ||
    proposed.categoryId !== row.categoryId ||
    proposed.birthYear !== Number(row.birthYear) ||
    proposed.gender !== row.gender ||
    cleanName(proposed.firstName) !== cleanName(row.firstName) ||
    cleanName(proposed.lastName) !== cleanName(row.lastName)
  )
    return false;
  const before = preview.before;
  if (mode === 'update') return before.archivedAt === null;
  return (
    before.archivedAt !== null &&
    before.archivedAt === entry.archivedAt &&
    before.categoryId === entry.categoryId &&
    before.clubId === entry.clubId &&
    before.birthYear === entry.birthYear &&
    (before.gender ?? categoryGender) === (entry.gender ?? categoryGender) &&
    cleanName(before.firstName) === cleanName(entry.firstName) &&
    cleanName(before.lastName) === cleanName(entry.lastName)
  );
}
