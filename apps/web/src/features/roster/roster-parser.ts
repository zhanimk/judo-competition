import type { Category } from '../tournaments/types';
import { blankRow, type DraftRow } from './roster-model.ts';
const headers = [
  ['lastname', 'фамилия', 'тегі'],
  ['firstname', 'имя', 'аты'],
  ['birthyear', 'год рождения', 'туған жылы'],
  ['gender', 'пол', 'жынысы'],
  ['category', 'categoryname', 'категория', 'санат'],
];
const genders: Record<string, 'MALE' | 'FEMALE'> = {
  MALE: 'MALE',
  FEMALE: 'FEMALE',
  М: 'MALE',
  Ж: 'FEMALE',
  МУЖСКОЙ: 'MALE',
  ЖЕНСКИЙ: 'FEMALE',
  ЕР: 'MALE',
  ӘЙЕЛ: 'FEMALE',
};
export function parseRosterText(
  source: string,
  categories: Category[],
): { rows: DraftRow[]; issues: { line: number; code: string }[]; fatal: boolean } {
  const rows: DraftRow[] = [],
    issues: { line: number; code: string }[] = [];
  let first = true,
    fatal = false;
  for (const [index, original] of source.split(/\r?\n/).entries()) {
    if (!original.trim()) continue;
    const cells = original.split(original.includes('\t') ? '\t' : ';').map((value) => value.trim());
    if (
      first &&
      cells.length === 5 &&
      cells.every((cell, column) => headers[column].includes(cell.toLocaleLowerCase()))
    ) {
      first = false;
      continue;
    }
    first = false;
    if (cells.length !== 5 || cells.some((cell) => cell.includes('"'))) {
      issues.push({ line: index + 1, code: 'TEXT_FORMAT' });
      fatal = true;
      continue;
    }
    const [lastName, firstName, birthYear, genderText, categoryName] = cells;
    const matches = categories.filter((category) => category.name === categoryName);
    const gender = genders[genderText.toLocaleUpperCase()] ?? '';
    if (!gender) issues.push({ line: index + 1, code: 'GENDER_REQUIRED' });
    if (matches.length !== 1) issues.push({ line: index + 1, code: 'TEXT_CATEGORY' });
    rows.push({
      ...blankRow(),
      lastName,
      firstName,
      birthYear,
      gender,
      categoryId: matches.length === 1 ? matches[0].id : '',
    });
  }
  if (rows.length > 500) {
    issues.push({ line: 0, code: 'BATCH_LIMIT' });
    fatal = true;
  }
  return { rows, issues, fatal };
}
