export type Entry = {
  id: string;
  firstName: string;
  lastName: string;
  birthYear?: number;
  club: string;
};
export type Category = {
  homeTatamiId?: string | null;
  draw?: { status: string; publishedAt: string | null; _count: { contests: number } } | null;
  format: string;
  id: string;
  name: string;
  gender: string;
  birthYearFrom: number;
  birthYearTo: number;
  maxWeightGrams: number | null;
  minWeightGrams?: number | null;
  durationSeconds: number;
  entries?: Entry[];
  _count?: { entries: number };
};
export type Tournament = {
  rulesSnapshot?: { version: string; tieBreak: string; drawPolicy?: string; approvedAt?: string };
  id: string;
  name: string;
  city: string;
  venue: string;
  startDate: string;
  endDate: string;
  tatamiCount: number;
  publishedAt?: string | null;
  status: string;
  categories: Category[];
  tatamis?: { id: string; number: number; status: string }[];
};
