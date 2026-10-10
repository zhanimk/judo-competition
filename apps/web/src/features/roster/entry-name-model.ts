import type { Category, Entry, Tournament } from '../tournaments/types';
import { isUuid, validSavedEntry, type SavedEntry } from './roster-model.ts';

export type NameCorrectionPayload = {
  id: string;
  expectedRevision: number;
  firstName: string;
  lastName: string;
  reason: string;
};
export type NameReview = {
  before: SavedEntry;
  firstName: string;
  lastName: string;
  reason: string;
  revision: number;
  signature: string;
};
export const normalizeEntryName = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ');

/** Preserve legacy nulls: changing a name must not fill in sporting or identity fields. */
export function savedNameEntry(entry: Entry, category: Category): SavedEntry | null {
  const snapshot = {
    ...entry,
    categoryId: category.id,
    clubId: entry.clubId ?? null,
    birthYear: entry.birthYear ?? null,
    gender: entry.gender ?? null,
    archivedAt: entry.archivedAt ?? null,
  };
  return validSavedEntry(snapshot) ? snapshot : null;
}

export function canCorrectEntryName(tournament: Tournament, entry: SavedEntry): boolean {
  if (entry.archivedAt !== null) return false;
  const category = tournament.categories.find((value) => value.id === entry.categoryId);
  if (!category?.entries?.some((value) => value.id === entry.id && !value.archivedAt)) return false;
  return (
    tournament.status === 'RUNNING' ||
    tournament.status === 'FINISHED' ||
    (tournament.status === 'DRAFT' && category.draw?.status === 'CONFIRMED')
  );
}

export function nameCorrectionErrors(
  before: SavedEntry,
  firstName: string,
  lastName: string,
  reason: string,
): string[] {
  const names = [firstName, lastName].map(normalizeEntryName);
  const errors = [];
  if (names.some((name) => !name)) errors.push('NAME_REQUIRED');
  if (names.some((name) => name.length > 80)) errors.push('NAME_TOO_LONG');
  if (reason.trim().length < 3 || reason.trim().length > 500) errors.push('REASON_REQUIRED');
  if (
    names[0] === normalizeEntryName(before.firstName) &&
    names[1] === normalizeEntryName(before.lastName)
  )
    errors.push('NAME_UNCHANGED');
  return errors;
}

function snapshotFields(entry: SavedEntry) {
  return [
    entry.id,
    entry.athleteId ?? null,
    entry.categoryId,
    entry.clubId,
    entry.club,
    entry.birthYear,
    entry.gender,
    entry.archivedAt,
    entry.firstName,
    entry.lastName,
  ];
}
function reviewSignature(
  entry: SavedEntry,
  firstName: string,
  lastName: string,
  reason: string,
  revision: number,
) {
  return JSON.stringify([snapshotFields(entry), firstName, lastName, reason, revision]);
}
export function reviewEntryName(
  before: SavedEntry,
  firstName: string,
  lastName: string,
  reason: string,
  revision: number,
): NameReview | null {
  if (
    !validSavedEntry(before) ||
    before.archivedAt !== null ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    nameCorrectionErrors(before, firstName, lastName, reason).length
  )
    return null;
  return {
    before: structuredClone(before),
    firstName: normalizeEntryName(firstName),
    lastName: normalizeEntryName(lastName),
    reason: reason.trim(),
    revision,
    signature: reviewSignature(before, firstName, lastName, reason, revision),
  };
}
/** Polling, edits, or a different target require the administrator to review again. */
export function nameReviewMatches(
  review: NameReview | null,
  before: SavedEntry,
  firstName: string,
  lastName: string,
  reason: string,
  revision: number,
): boolean {
  return (
    !!review && review.signature === reviewSignature(before, firstName, lastName, reason, revision)
  );
}

export function validNameCorrectionPayload(value: unknown): value is NameCorrectionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const payload = value as NameCorrectionPayload;
  return (
    Object.keys(payload).sort().join(',') === 'expectedRevision,firstName,id,lastName,reason' &&
    isUuid(payload.id) &&
    Number.isSafeInteger(payload.expectedRevision) &&
    payload.expectedRevision >= 0 &&
    [payload.firstName, payload.lastName].every(
      (name) =>
        typeof name === 'string' &&
        normalizeEntryName(name).length > 0 &&
        normalizeEntryName(name).length <= 80,
    ) &&
    typeof payload.reason === 'string' &&
    payload.reason.trim().length >= 3 &&
    payload.reason.length <= 500
  );
}

export function nameReceiptPreservesEntry(before: SavedEntry, after: SavedEntry): boolean {
  return snapshotFields(before)
    .slice(0, 8)
    .every((field, index) => field === snapshotFields(after)[index]);
}
