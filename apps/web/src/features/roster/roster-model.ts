import type { Category, Club, Entry, Tournament } from '../tournaments/types';

export type DraftRow = {
  localId: string;
  lastName: string;
  firstName: string;
  birthYear: string;
  gender: '' | 'MALE' | 'FEMALE';
  categoryId: string;
  duplicateConfirmed?: boolean;
};
export type RosterEntryInput = {
  lastName: string;
  firstName: string;
  birthYear: number;
  gender: 'MALE' | 'FEMALE';
  categoryId: string;
  duplicateConfirmed?: boolean;
};
export type Duplicate = {
  entryId: string;
  categoryId: string;
  club: string;
  firstName: string;
  lastName: string;
  birthYear: number;
};
export type PreviewRow = {
  index: number;
  errors: string[];
  duplicateCount: number;
  possibleDuplicates: Duplicate[];
};
export type RosterPreview = { revision: number; rows: PreviewRow[]; canSave: boolean };
export type ClubReceipt = { revision: number; club: Club };
export type RosterReceipt = {
  revision: number;
  clubId: string;
  entries: (Entry & { categoryId: string; gender: 'MALE' | 'FEMALE'; clubId: string })[];
};
export type Receipt = ClubReceipt | RosterReceipt;
export function blankRow(): DraftRow {
  return {
    localId: crypto.randomUUID(),
    lastName: '',
    firstName: '',
    birthYear: '',
    gender: '',
    categoryId: '',
  };
}
export function eligibleCategories(row: DraftRow, categories: Category[]): Category[] {
  if (!/^\d{4}$/.test(row.birthYear) || !row.gender) return [];
  const year = Number(row.birthYear);
  return categories.filter(
    (category) =>
      category.gender === row.gender &&
      year >= category.birthYearFrom &&
      year <= category.birthYearTo &&
      category.draw?.status !== 'CONFIRMED',
  );
}
export function rowErrors(row: DraftRow, categories: Category[]): string[] {
  const errors: string[] = [];
  if (!row.lastName.trim() || !row.firstName.trim()) errors.push('NAME_REQUIRED');
  if (row.lastName.trim().length > 80 || row.firstName.trim().length > 80)
    errors.push('NAME_TOO_LONG');
  if (
    !/^\d{4}$/.test(row.birthYear) ||
    Number(row.birthYear) < 1900 ||
    Number(row.birthYear) > 2100
  )
    errors.push('BIRTH_YEAR_INVALID');
  if (!row.gender) errors.push('GENDER_REQUIRED');
  const category = categories.find((item) => item.id === row.categoryId);
  if (!category) errors.push('CATEGORY_NOT_FOUND');
  else {
    if (category.draw?.status === 'CONFIRMED') errors.push('DRAW_LOCKED');
    if (row.gender && category.gender !== row.gender) errors.push('GENDER_MISMATCH');
    if (
      /^\d{4}$/.test(row.birthYear) &&
      (Number(row.birthYear) < category.birthYearFrom ||
        Number(row.birthYear) > category.birthYearTo)
    )
      errors.push('BIRTH_YEAR_OUT_OF_RANGE');
  }
  return errors;
}
export function entryInputs(rows: DraftRow[]): RosterEntryInput[] {
  return rows.map((row) => ({
    lastName: row.lastName.trim(),
    firstName: row.firstName.trim(),
    birthYear: Number(row.birthYear),
    gender: row.gender as 'MALE' | 'FEMALE',
    categoryId: row.categoryId,
    ...(row.duplicateConfirmed ? { duplicateConfirmed: true } : {}),
  }));
}
export function rowsSignature(rows: DraftRow[]): string {
  return JSON.stringify(entryInputs(rows));
}
export function previewMatchesDraft(
  checked: { signature: string; data: RosterPreview } | null,
  rows: DraftRow[],
  revision: number,
): boolean {
  return (
    checked !== null &&
    checked.signature === rowsSignature(rows) &&
    checked.data.revision === revision
  );
}
export function removeSubmittedDraft(draft: DraftRow[], submitted: DraftRow[]): DraftRow[] {
  const submittedIds = new Set(submitted.map((row) => row.localId));
  return draft.filter((row) => !submittedIds.has(row.localId));
}
export function samePersonInput(left: DraftRow, right: DraftRow): boolean {
  return (
    left.firstName === right.firstName &&
    left.lastName === right.lastName &&
    left.birthYear === right.birthYear &&
    left.gender === right.gender &&
    left.categoryId === right.categoryId
  );
}
export function acceptRosterSnapshot(
  current: Tournament | null,
  value: Tournament,
  tournamentId: string,
): Tournament | null {
  if (
    value.id !== tournamentId ||
    !Number.isSafeInteger(value.rosterRevision) ||
    value.rosterRevision < 0 ||
    (current && value.rosterRevision < current.rosterRevision)
  )
    return current;
  return value;
}
export function validRosterPreview(value: RosterPreview, count: number): boolean {
  return (
    Number.isSafeInteger(value?.revision) &&
    value.revision >= 0 &&
    typeof value.canSave === 'boolean' &&
    Array.isArray(value.rows) &&
    value.rows.length === count &&
    value.rows.every(
      (row, index) =>
        !!row &&
        row.index === index &&
        Array.isArray(row.errors) &&
        row.errors.every((error) => typeof error === 'string') &&
        Number.isSafeInteger(row.duplicateCount) &&
        row.duplicateCount >= 0 &&
        Array.isArray(row.possibleDuplicates) &&
        row.possibleDuplicates.length <= 5 &&
        row.possibleDuplicates.length <= row.duplicateCount &&
        row.possibleDuplicates.every(
          (duplicate) =>
            typeof duplicate.entryId === 'string' &&
            typeof duplicate.firstName === 'string' &&
            typeof duplicate.lastName === 'string' &&
            typeof duplicate.club === 'string' &&
            typeof duplicate.categoryId === 'string' &&
            Number.isInteger(duplicate.birthYear),
        ),
    ) &&
    (!value.canSave || value.rows.every((row) => !row.errors.length))
  );
}
/** Old receipts are acknowledged without replacing a newer authoritative roster. */
export function mergeRosterReceipt(tournament: Tournament, receipt: Receipt): Tournament {
  if (receipt.revision <= tournament.rosterRevision) return tournament;
  if ('club' in receipt)
    return {
      ...tournament,
      rosterRevision: receipt.revision,
      clubs: tournament.clubs.some((club) => club.id === receipt.club.id)
        ? tournament.clubs
        : [...tournament.clubs, receipt.club],
    };
  const categories = tournament.categories.map((category) => {
    const entries = [...(category.entries ?? [])];
    for (const entry of receipt.entries.filter((entry) => entry.categoryId === category.id))
      if (!entries.some((current) => current.id === entry.id)) entries.push(entry);
    return { ...category, entries, _count: { ...category._count, entries: entries.length } };
  });
  const clubs = tournament.clubs.map((club) => ({
    ...club,
    _count: {
      entries: categories.reduce(
        (sum, category) =>
          sum + (category.entries ?? []).filter((entry) => entry.clubId === club.id).length,
        0,
      ),
    },
  }));
  return { ...tournament, rosterRevision: receipt.revision, categories, clubs };
}
