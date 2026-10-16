import { placements, resolveMatches, poolStandings, type Draw, type Slot } from '@judo/engine/draw';
import type { Category, Entry, DrawRecord, Contest, Tournament } from '@prisma/client';
export const PROTOCOL_KINDS = [
  'DRAW',
  'PARTICIPANTS',
  'BOUTS',
  'RESULTS',
  'TEAMS',
  'MEDALS',
  'ALL',
] as const;
export type ProtocolKind = (typeof PROTOCOL_KINDS)[number];
export type ProtocolCategory = Category & {
  entries: Entry[];
  draw: (DrawRecord & { contests: Contest[] }) | null;
};
export type ProtocolTournament = Tournament & { categories: ProtocolCategory[] };
export type Translate = (ru: string, kk: string) => string;
export const titles: Record<ProtocolKind, [string, string]> = {
  DRAW: ['Сетка', 'Тор'],
  PARTICIPANTS: ['Список участников', 'Қатысушылар тізімі'],
  BOUTS: ['Протокол схваток', 'Белдесулер хаттамасы'],
  RESULTS: ['Итоги категорий', 'Санаттар қорытындысы'],
  TEAMS: ['Общекомандный зачёт', 'Жалпыкомандалық есеп'],
  MEDALS: ['Медальный зачёт', 'Медальдық есеп'],
  ALL: ['Все протоколы', 'Барлық хаттамалар'],
};
export function categoryResults(c: ProtocolCategory) {
  if (!c.draw) return null;
  const draw = c.draw.snapshot as unknown as Draw;
  const winners = Object.fromEntries(
    c.draw.contests
      .filter((m) => m.status === 'CONFIRMED' && m.winnerEntryId)
      .map((m) => [m.key, m.winnerEntryId!]),
  );
  return {
    draw,
    winners,
    places: c.draw.status === 'CONFIRMED' ? placements(draw, winners) : null,
  };
}
export function slotName(c: ProtocolCategory, text: Translate) {
  const results = categoryResults(c);
  const resolved = results ? resolveMatches(results.draw, results.winners) : [];
  const name = (slot: Slot | null): string => {
    if (!slot) return 'BYE';
    if ('entryId' in slot) {
      const e = c.entries.find((e) => e.id === slot.entryId);
      return e ? `${e.lastName} ${e.firstName}\n${e.club}` : '—';
    }
    if ('pool' in slot) {
      const entry =
        results && poolStandings(results.draw, results.winners, slot.pool)?.[slot.place - 1];
      return entry
        ? name({ entryId: entry.entryId })
        : `${text('Группа', 'Топ')} ${slot.pool} · ${slot.place}`;
    }
    const id = 'winnerOf' in slot ? slot.winnerOf : slot.loserOf;
    const m = resolved.find((m) => m.id === id);
    if (m?.voided || (m && 'loserOf' in slot && (m.whiteEmpty || m.blueEmpty)))
      return text('Нет участника', 'Қатысушы жоқ');
    if (m?.winnerEntryId)
      return name({
        entryId:
          'winnerOf' in slot
            ? m.winnerEntryId
            : (m.winnerEntryId === m.whiteEntryId ? m.blueEntryId : m.whiteEntryId)!,
      });
    return `${'winnerOf' in slot ? text('Победитель', 'Жеңімпаз') : text('Проигравший', 'Жеңілген')} ${id}`;
  };
  return name;
}
/** Same club normalization as the draw. No fuzzy merges; only finalized categories award medals. */
export function teamStandings(categories: ProtocolCategory[]) {
  const teams = new Map<
    string,
    {
      club: string;
      gold: number;
      silver: number;
      bronze: number;
      members: { entry: Entry; category: string; place?: number; complete: boolean }[];
    }
  >();
  let complete = 0;
  for (const c of categories) {
    const places = categoryResults(c)?.places;
    if (places) complete++;
    for (const entry of c.entries) {
      const key = entry.club.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
      const team = teams.get(key) ?? {
        club: entry.club.trim(),
        gold: 0,
        silver: 0,
        bronze: 0,
        members: [],
      };
      const place = places?.find((p) => p.entryId === entry.id)?.place;
      if (place === 1) team.gold++;
      if (place === 2) team.silver++;
      if (place === 3) team.bronze++;
      team.members.push({ entry, category: c.name, place, complete: !!places });
      teams.set(key, team);
    }
  }
  const sorted = [...teams.values()].sort(
    (a, b) =>
      b.gold - a.gold || b.silver - a.silver || b.bronze - a.bronze || a.club.localeCompare(b.club),
  );
  let rank = 0;
  return {
    complete,
    teams: sorted.map((t, i) => {
      const prev = sorted[i - 1];
      if (!prev || prev.gold !== t.gold || prev.silver !== t.silver || prev.bronze !== t.bronze)
        rank = i + 1;
      return {
        ...t,
        rank:
          (complete === categories.length && categories.length > 0) || t.gold + t.silver + t.bronze
            ? rank
            : null,
      };
    }),
  };
}
