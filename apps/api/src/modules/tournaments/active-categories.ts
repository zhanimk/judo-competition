import { ConflictException } from '@nestjs/common';

type CountedCategory = {
  id: string;
  name: string;
  _count: { entries: number };
  draw: { status: string } | null;
};

/** Empty configurations remain saved; only active admissions enter competition.
 * A lone athlete needs an explicit sporting policy, never an invented win. */
export function requireCompetitionCategories<T extends CountedCategory>(categories: readonly T[]) {
  const active = categories.filter((category) => category._count.entries > 0);
  if (!active.length) throw new ConflictException('NO_ACTIVE_CATEGORIES');
  const single = active.filter((category) => category._count.entries === 1);
  if (single.length)
    throw new ConflictException({
      message: 'CATEGORY_NEEDS_OPPONENT',
      categories: single.map(({ id, name }) => ({ id, name })),
    });
  if (active.some((category) => category.draw?.status !== 'CONFIRMED'))
    throw new ConflictException('ALL_DRAWS_REQUIRED');
  return active;
}
