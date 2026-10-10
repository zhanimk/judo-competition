import type { Category } from './types';

export function activeEntryCount(category: Category) {
  return category.entries
    ? category.entries.filter((entry) => !entry.archivedAt).length
    : (category._count?.entries ?? 0);
}

/** Empty templates stay editable, but never create bouts or medal winners. */
export function startReadiness(categories: Category[]) {
  const empty = categories.filter((category) => activeEntryCount(category) === 0);
  const active = categories.filter((category) => activeEntryCount(category) > 0);
  const single = active.filter((category) => activeEntryCount(category) === 1);
  const unconfirmed = active.filter((category) => category.draw?.status !== 'CONFIRMED');
  return {
    empty,
    active,
    single,
    unconfirmed,
    ready: active.length > 0 && !single.length && !unconfirmed.length,
  };
}
