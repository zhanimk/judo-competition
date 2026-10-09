import {
  isUuid,
  validSavedEntry,
  validCategoryIds,
  type AthleteDisplay,
  type DraftRow,
  type SavedEntry,
} from './roster-model.ts';

export type AthleteCandidate = {
  id: string;
  display: AthleteDisplay;
  activeEntry: { entryId: string; categoryId: string } | null;
};
export type EntryIdentityPreview = {
  revision: number;
  before: SavedEntry;
  proposed: SavedEntry;
  athlete: { id: string; display: AthleteDisplay };
  errors: string[];
  canSave: boolean;
  affectedCategoryIds: string[];
  invalidatedCategoryIds: string[];
};
export function validAthleteDisplay(value: unknown): value is AthleteDisplay {
  if (!value || typeof value !== 'object') return false;
  const display = value as AthleteDisplay;
  return (
    isUuid(display.entryId) &&
    isUuid(display.tournamentId) &&
    [display.firstName, display.lastName, display.club].every(
      (value) => typeof value === 'string',
    ) &&
    (display.birthYear === null || Number.isInteger(display.birthYear)) &&
    ['MALE', 'FEMALE'].includes(display.gender)
  );
}
export function validAthleteCandidates(value: unknown): value is { athletes: AthleteCandidate[] } {
  if (!value || typeof value !== 'object') return false;
  const athletes = (value as { athletes: AthleteCandidate[] }).athletes;
  return (
    Array.isArray(athletes) &&
    athletes.length <= 20 &&
    new Set(athletes.map((value) => value?.id)).size === athletes.length &&
    athletes.every(
      (athlete) =>
        athlete &&
        isUuid(athlete.id) &&
        validAthleteDisplay(athlete.display) &&
        (athlete.activeEntry === null ||
          (athlete.activeEntry &&
            isUuid(athlete.activeEntry.entryId) &&
            isUuid(athlete.activeEntry.categoryId))),
    )
  );
}
export function chooseAthlete(row: DraftRow, athlete: AthleteCandidate): DraftRow {
  return {
    ...row,
    athleteId: athlete.id,
    athleteDisplay: structuredClone(athlete.display),
    firstName: athlete.display.firstName,
    lastName: athlete.display.lastName,
    birthYear: String(athlete.display.birthYear ?? ''),
    gender: athlete.display.gender,
    categoryId: '',
    duplicateConfirmed: false,
  };
}
export function newAthlete(row: DraftRow): DraftRow {
  const { athleteId: _id, athleteDisplay: _display, ...fields } = row;
  return { ...fields, duplicateConfirmed: false };
}
export function sameEntryPersonalData(left: SavedEntry, right: SavedEntry): boolean {
  return [
    'id',
    'categoryId',
    'clubId',
    'firstName',
    'lastName',
    'birthYear',
    'gender',
    'club',
    'archivedAt',
  ].every((field) => left[field as keyof SavedEntry] === right[field as keyof SavedEntry]);
}
export function identitySignature(athleteId: string, reason: string, revision: number): string {
  return JSON.stringify([athleteId, reason, revision]);
}
export function identityPreviewMatches(
  value: EntryIdentityPreview,
  entryId: string,
  athleteId: string,
): boolean {
  return (
    Number.isSafeInteger(value?.revision) &&
    value.revision >= 0 &&
    validSavedEntry(value.before) &&
    validSavedEntry(value.proposed) &&
    value.before.id === entryId &&
    value.before.archivedAt === null &&
    isUuid(value.before.athleteId) &&
    value.proposed.athleteId === athleteId &&
    value.athlete?.id === athleteId &&
    validAthleteDisplay(value.athlete.display) &&
    sameEntryPersonalData(value.before, value.proposed) &&
    Array.isArray(value.errors) &&
    value.errors.every((code) => typeof code === 'string') &&
    typeof value.canSave === 'boolean' &&
    (!value.canSave || !value.errors.length) &&
    validCategoryIds(value.affectedCategoryIds) &&
    validCategoryIds(value.invalidatedCategoryIds) &&
    value.invalidatedCategoryIds.every((id) => value.affectedCategoryIds.includes(id))
  );
}
