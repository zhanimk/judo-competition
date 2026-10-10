export type ExportCategory = {
  id: string;
  name: string;
  _count?: { entries: number };
  entries?: { archivedAt?: string | null }[];
};
export type ExportKind = 'DRAW' | 'PARTICIPANTS' | 'TEAMS';

export function exportEntryCount(category: ExportCategory) {
  return category.entries
    ? category.entries.filter((entry) => !entry.archivedAt).length
    : (category._count?.entries ?? 0);
}

export function exportCategories(categories: readonly ExportCategory[], kind: ExportKind) {
  return kind === 'DRAW' || kind === 'TEAMS'
    ? categories.filter((category) => exportEntryCount(category) > 0)
    : categories;
}

export function exportSelection(
  categories: readonly ExportCategory[],
  kind: ExportKind,
  selected: readonly string[],
) {
  const available = new Set(exportCategories(categories, kind).map((category) => category.id));
  return selected.filter((id) => available.has(id));
}
