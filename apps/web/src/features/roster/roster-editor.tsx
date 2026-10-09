'use client';

import { useLanguage } from '../../shared/i18n/provider';
import type { Category } from '../tournaments/types';
import { rosterMessage } from './messages';
import {
  eligibleCategories,
  rowErrors,
  samePersonInput,
  type DraftRow,
  type RosterPreview,
} from './roster-model';

export type CheckedDraft = { data: RosterPreview; rows: DraftRow[]; signature: string };
export function RosterEditor({
  rows,
  categories,
  checked,
  disabled,
  showValidation,
  onChange,
}: {
  rows: DraftRow[];
  categories: Category[];
  checked: CheckedDraft | null;
  disabled: boolean;
  showValidation: boolean;
  onChange: (rows: DraftRow[]) => void;
}) {
  const { text, locale } = useLanguage();
  const update = (row: DraftRow, values: Partial<DraftRow>) =>
    onChange(
      rows.map((current) =>
        current.localId === row.localId
          ? { ...row, duplicateConfirmed: false, ...values }
          : current,
      ),
    );
  return (
    <div className="roster-editor">
      {rows.map((row, index) => {
        const eligible = eligibleCategories(row, categories);
        const selected = categories.find((category) => category.id === row.categoryId);
        const previousIndex =
          checked?.rows.findIndex((previous) => previous.localId === row.localId) ?? -1;
        const report =
          previousIndex >= 0 && checked && samePersonInput(row, checked.rows[previousIndex])
            ? checked.data.rows[previousIndex]
            : null;
        const localErrors = showValidation ? rowErrors(row, categories) : [];
        const errors = [
          ...new Set([
            ...localErrors,
            ...(report?.errors.filter(
              (code) => code !== 'DUPLICATE_CONFIRMATION_REQUIRED' || !row.duplicateConfirmed,
            ) ?? []),
          ]),
        ];
        return (
          <fieldset className="roster-row" key={row.localId} disabled={disabled}>
            <legend>
              {text('Спортсмен', 'Спортшы')} {index + 1}
            </legend>
            <div className="roster-row-fields">
              <label>
                {text('Фамилия', 'Тегі')}
                <input
                  maxLength={80}
                  value={row.lastName}
                  onChange={(event) => update(row, { lastName: event.target.value })}
                />
              </label>
              <label>
                {text('Имя', 'Аты')}
                <input
                  maxLength={80}
                  value={row.firstName}
                  onChange={(event) => update(row, { firstName: event.target.value })}
                />
              </label>
              <label>
                {text('Год рождения', 'Туған жылы')}
                <input
                  inputMode="numeric"
                  maxLength={4}
                  value={row.birthYear}
                  onChange={(event) => update(row, { birthYear: event.target.value })}
                />
              </label>
              <label>
                {text('Пол', 'Жынысы')}
                <select
                  value={row.gender}
                  onChange={(event) =>
                    update(row, { gender: event.target.value as DraftRow['gender'] })
                  }
                >
                  <option value="">{text('Выберите', 'Таңдаңыз')}</option>
                  <option value="MALE">{text('Мужской', 'Ер')}</option>
                  <option value="FEMALE">{text('Женский', 'Әйел')}</option>
                </select>
              </label>
              <label>
                {text('Категория', 'Санат')}
                <select
                  value={row.categoryId}
                  onChange={(event) => update(row, { categoryId: event.target.value })}
                >
                  <option value="">{text('Выберите явно', 'Нақты таңдаңыз')}</option>
                  {row.categoryId &&
                    !eligible.some((category) => category.id === row.categoryId) && (
                      <option value={row.categoryId} disabled>
                        {selected?.name ?? text('Категория недоступна', 'Санат қолжетімсіз')}
                      </option>
                    )}
                  {eligible.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="roster-remove"
                type="button"
                onClick={() => onChange(rows.filter((current) => current.localId !== row.localId))}
                aria-label={`${text('Удалить строку', 'Жолды жою')} ${index + 1}`}
              >
                ×
              </button>
            </div>
            {!row.categoryId && (
              <p className="field-note">
                {text(
                  'Сначала укажите год рождения и пол. Затем выберите подходящую категорию; вес не определяется автоматически.',
                  'Алдымен туған жылы мен жынысын енгізіңіз. Содан кейін сәйкес санатты таңдаңыз; салмақ автоматты анықталмайды.',
                )}
              </p>
            )}
            {errors.length > 0 && (
              <ul className="roster-errors">
                {errors.map((code) => (
                  <li key={code}>{rosterMessage(code, locale === 'kk')}</li>
                ))}
              </ul>
            )}
            {!!report?.duplicateCount && (
              <div className="roster-duplicates">
                <strong>
                  {text('Возможные совпадения', 'Ықтимал сәйкестіктер')}: {report.duplicateCount}
                </strong>
                <ul>
                  {report.possibleDuplicates.map((duplicate) => (
                    <li key={duplicate.entryId}>
                      {duplicate.lastName} {duplicate.firstName} · {duplicate.birthYear} ·{' '}
                      {duplicate.club} ·{' '}
                      {categories.find((category) => category.id === duplicate.categoryId)?.name ??
                        '—'}
                      {duplicate.entryId.startsWith('batch:') &&
                        ` · ${text('строка заявки', 'өтінім жолы')} ${Number(duplicate.entryId.slice(6)) + 1}`}
                    </li>
                  ))}
                </ul>
                {report.duplicateCount > report.possibleDuplicates.length && (
                  <p>
                    {text(
                      `Показаны первые ${report.possibleDuplicates.length} из ${report.duplicateCount}. Перед подтверждением проверьте весь состав клуба и строки заявки.`,
                      `${report.duplicateCount} сәйкестіктің алғашқы ${report.possibleDuplicates.length} көрсетілген. Растамас бұрын клубтың бүкіл құрамы мен өтінім жолдарын тексеріңіз.`,
                    )}
                  </p>
                )}
                <label className="roster-checkbox">
                  <input
                    type="checkbox"
                    checked={!!row.duplicateConfirmed}
                    onChange={(event) => update(row, { duplicateConfirmed: event.target.checked })}
                  />
                  {text(
                    'Проверены все возможные совпадения: это отдельный спортсмен. Записи не объединять.',
                    'Барлық ықтимал сәйкестік тексерілді: бұл бөлек спортшы. Жазбаларды біріктірмеу.',
                  )}
                </label>
              </div>
            )}
          </fieldset>
        );
      })}
    </div>
  );
}
