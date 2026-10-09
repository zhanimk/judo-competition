'use client';

import { useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { chooseAthlete, newAthlete } from './athlete-model';
import { AthleteDetails, AthletePicker } from './athlete-picker';
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
  allowRemove = true,
  readonlyFields = false,
  tournamentId,
}: {
  rows: DraftRow[];
  categories: Category[];
  checked: CheckedDraft | null;
  disabled: boolean;
  showValidation: boolean;
  onChange: (rows: DraftRow[]) => void;
  allowRemove?: boolean;
  readonlyFields?: boolean;
  tournamentId?: string;
}) {
  const { text, locale } = useLanguage();
  const [selectingRow, setSelectingRow] = useState<string | null>(null);
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
            <div className={`roster-row-fields${allowRemove ? '' : ' roster-row-fields-single'}`}>
              <label className="roster-field-name">
                {text('Фамилия', 'Тегі')}
                <input
                  disabled={readonlyFields}
                  maxLength={80}
                  value={row.lastName}
                  onChange={(event) => update(row, { lastName: event.target.value })}
                />
              </label>
              <label className="roster-field-name">
                {text('Имя', 'Аты')}
                <input
                  disabled={readonlyFields}
                  maxLength={80}
                  value={row.firstName}
                  onChange={(event) => update(row, { firstName: event.target.value })}
                />
              </label>
              <label className="roster-field-year">
                {text('Год рождения', 'Туған жылы')}
                <input
                  disabled={readonlyFields}
                  inputMode="numeric"
                  maxLength={4}
                  value={row.birthYear}
                  onChange={(event) => update(row, { birthYear: event.target.value })}
                />
              </label>
              <label className="roster-field-gender">
                {text('Пол', 'Жынысы')}
                <select
                  disabled={readonlyFields}
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
              <label className="roster-field-category">
                {text('Категория', 'Санат')}
                <select
                  disabled={readonlyFields}
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
              {allowRemove && (
                <button
                  className="roster-remove"
                  type="button"
                  onClick={() =>
                    onChange(rows.filter((current) => current.localId !== row.localId))
                  }
                  aria-label={`${text('Удалить строку', 'Жолды жою')} ${index + 1}`}
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </div>
            {tournamentId && (
              <div className="roster-athlete-choice">
                {row.athleteId ? (
                  <>
                    <strong>
                      {text('Выбран существующий спортсмен', 'Бұрынғы спортшы таңдалған')}
                    </strong>
                    {row.athleteDisplay && <AthleteDetails display={row.athleteDisplay} />}
                    <p className="field-note">
                      {text(
                        'Поля этой заявки можно изменить; прежние заявки сохраняют свои данные.',
                        'Осы өтінімнің өрістерін өзгертуге болады; бұрынғы өтінімдер өз деректерін сақтайды.',
                      )}
                    </p>
                  </>
                ) : (
                  <span>{text('Новая запись спортсмена', 'Спортшының жаңа жазбасы')}</span>
                )}
                <div className="roster-entry-actions">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setSelectingRow(row.localId)}
                  >
                    {text('Выбрать из истории', 'Тарихтан таңдау')}
                  </button>
                  {row.athleteId && (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        onChange(
                          rows.map((value) =>
                            value.localId === row.localId ? newAthlete(row) : value,
                          ),
                        );
                        setSelectingRow(null);
                      }}
                    >
                      {text(
                        'Это другой спортсмен — новая запись',
                        'Бұл басқа спортшы — жаңа жазба',
                      )}
                    </button>
                  )}
                </div>
                {selectingRow === row.localId && (
                  <AthletePicker
                    tournamentId={tournamentId}
                    categories={categories}
                    disabled={disabled}
                    selectedId={row.athleteId}
                    unavailableIds={rows
                      .filter((value) => value.localId !== row.localId)
                      .flatMap((value) => (value.athleteId ? [value.athleteId] : []))}
                    onClose={() => setSelectingRow(null)}
                    onSelect={(athlete) => {
                      onChange(
                        rows.map((value) =>
                          value.localId === row.localId ? chooseAthlete(row, athlete) : value,
                        ),
                      );
                      setSelectingRow(null);
                    }}
                  />
                )}
              </div>
            )}
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
