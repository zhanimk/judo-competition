import type { RosterEntryDto } from './roster.dto.js';

export const cleanName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ');
export const normalizedName = (name: string) => cleanName(name).toLocaleLowerCase('ru');

type ExistingEntry = {
  id: string;
  categoryId: string;
  firstName: string;
  lastName: string;
  birthYear: number;
  club: string;
};
export type RosterSnapshot = {
  status: string;
  rosterRevision: number;
  categories: {
    id: string;
    gender: string;
    birthYearFrom: number;
    birthYearTo: number;
    draw: { status: string } | null;
    entries: ExistingEntry[];
  }[];
};
export type PossibleDuplicate = Omit<ExistingEntry, 'id'> & { entryId: string };
export type RosterRowResult = {
  index: number;
  errors: string[];
  possibleDuplicates: PossibleDuplicate[];
  duplicateCount: number;
};

const identity = (entry: Pick<ExistingEntry, 'firstName' | 'lastName' | 'birthYear'>) =>
  JSON.stringify([
    normalizedName(entry.firstName),
    normalizedName(entry.lastName),
    entry.birthYear,
  ]);

/** Validation reads a complete snapshot and never merges or changes people. */
export function validateRoster(
  snapshot: RosterSnapshot,
  clubName: string,
  entries: RosterEntryDto[],
) {
  const categories = new Map(snapshot.categories.map((category) => [category.id, category]));
  const existing = new Map<string, PossibleDuplicate[]>();
  for (const category of snapshot.categories)
    for (const entry of category.entries) {
      const key = identity(entry);
      const duplicate = {
        entryId: entry.id,
        categoryId: entry.categoryId,
        club: entry.club,
        firstName: entry.firstName,
        lastName: entry.lastName,
        birthYear: entry.birthYear,
      };
      const matches = existing.get(key) ?? [];
      matches.push(duplicate);
      existing.set(key, matches);
    }
  const batch = new Map<string, { index: number; duplicate: PossibleDuplicate }[]>();
  const counts = new Map<string, number>();
  entries.forEach((entry, index) => {
    counts.set(entry.categoryId, (counts.get(entry.categoryId) ?? 0) + 1);
    const key = identity(entry);
    const matches = batch.get(key) ?? [];
    matches.push({
      index,
      duplicate: {
        entryId: `batch:${index}`,
        categoryId: entry.categoryId,
        club: clubName,
        firstName: cleanName(entry.firstName),
        lastName: cleanName(entry.lastName),
        birthYear: entry.birthYear,
      },
    });
    batch.set(key, matches);
  });
  const rows: RosterRowResult[] = entries.map((entry, index) => {
    const errors: string[] = [];
    if (!cleanName(entry.firstName) || !cleanName(entry.lastName)) errors.push('NAME_REQUIRED');
    if (snapshot.status !== 'DRAFT') errors.push('ROSTER_LOCKED');
    const category = categories.get(entry.categoryId);
    if (!category) errors.push('CATEGORY_NOT_FOUND');
    else {
      if (category.draw?.status === 'CONFIRMED') errors.push('DRAW_LOCKED');
      if (entry.birthYear < category.birthYearFrom || entry.birthYear > category.birthYearTo)
        errors.push('BIRTH_YEAR_OUT_OF_RANGE');
      if (entry.gender !== category.gender) errors.push('GENDER_MISMATCH');
      if (category.entries.length + (counts.get(category.id) ?? 0) > 128)
        errors.push('CATEGORY_CAPACITY');
    }
    const key = identity(entry);
    const storedMatches = existing.get(key) ?? [];
    const batchMatches = batch.get(key) ?? [];
    const duplicateCount = storedMatches.length + batchMatches.length - 1;
    // An identical 500-row paste has 249,500 pairwise matches. Return a bounded
    // sample while still requiring acknowledgement based on the complete count.
    const possibleDuplicates = storedMatches.slice(0, 5);
    for (const match of batchMatches) {
      if (possibleDuplicates.length >= 5) break;
      if (match.index !== index) possibleDuplicates.push(match.duplicate);
    }
    if (duplicateCount > 0 && entry.duplicateConfirmed !== true)
      errors.push('DUPLICATE_CONFIRMATION_REQUIRED');
    return { index, errors, possibleDuplicates, duplicateCount };
  });
  return {
    revision: snapshot.rosterRevision,
    rows,
    canSave: rows.every((row) => row.errors.length === 0),
  };
}
