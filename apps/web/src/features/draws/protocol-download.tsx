'use client';
import { useId, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import {
  exportCategories,
  exportEntryCount,
  exportSelection,
  type ExportCategory,
} from './protocol-scope';
import './protocol-download.css';
const kinds = [
  [
    'DRAW',
    'Сетки и результаты',
    'Торлар мен нәтижелер',
    'Пары и сетки; подтверждённые результаты и итоговые места, включая две бронзы, если они предусмотрены.',
    'Жұптар мен торлар; расталған нәтижелер және қорытынды орындар, қарастырылған болса — екі қола жүлде.',
  ],
  [
    'PARTICIPANTS',
    'Участники по категориям',
    'Санаттар бойынша қатысушылар',
    'Списки по категориям: имя, год рождения и клуб.',
    'Санаттар бойынша тізімдер: аты-жөні, туған жылы және клубы.',
  ],
  [
    'TEAMS',
    'Командный зачёт',
    'Командалық есеп',
    'Итог по медалям: золото, серебро, бронза. Все включённые категории должны быть полностью подтверждены.',
    'Медальдар бойынша қорытынды: алтын, күміс, қола. Қосылған барлық санаттар толық расталуы керек.',
  ],
] as const;
type Kind = (typeof kinds)[number][0];
export function ProtocolDownload({
  tournamentId,
  categoryId,
}: {
  tournamentId: string;
  categoryId?: string;
}) {
  const { text, locale } = useLanguage(),
    dialog = useRef<HTMLDialogElement>(null),
    titleId = useId();
  const [kind, setKind] = useState<Kind>('DRAW'),
    [lang, setLang] = useState(locale),
    [scope, setScope] = useState<'ALL' | 'SELECTED'>(categoryId ? 'SELECTED' : 'ALL');
  const [categories, setCategories] = useState<ExportCategory[]>([]),
    [selected, setSelected] = useState<string[]>(categoryId ? [categoryId] : []);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false);
  const eligible = exportCategories(categories, kind);
  const chosen = exportSelection(categories, kind, selected);
  async function open() {
    setKind('DRAW');
    setLang(locale);
    setScope(categoryId ? 'SELECTED' : 'ALL');
    setSelected(categoryId ? [categoryId] : []);
    setError('');
    setDone(false);
    setLoading(true);
    dialog.current?.showModal();
    try {
      const r = await fetch(`/api/v1/tournaments/${tournamentId}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('LOAD');
      const t = (await r.json()) as { categories: ExportCategory[] };
      setCategories(t.categories);
      setSelected((prev) => prev.filter((id) => t.categories.some((c) => c.id === id)));
    } catch {
      setCategories([]);
      setError(
        text(
          'Не удалось загрузить категории. Закройте окно и повторите.',
          'Санаттарды жүктеу мүмкін болмады. Терезені жауып, қайталаңыз.',
        ),
      );
    } finally {
      setLoading(false);
    }
  }
  async function download() {
    if (busy || loading || !eligible.length || (scope === 'SELECTED' && !chosen.length)) return;
    setBusy(true);
    setError('');
    setDone(false);
    let pendingCategories: string[] = [];
    try {
      const query = new URLSearchParams({ lang, kind });
      if (scope === 'SELECTED') query.set('categoryIds', chosen.join(','));
      const r = await fetch(`/api/v1/tournaments/${tournamentId}/protocol.pdf?${query}`, {
        cache: 'no-store',
      });
      if (!r.ok) {
        const failure = await r.json().catch(() => null);
        if (failure?.message === 'TEAMS_NOT_READY' && Array.isArray(failure.categories))
          pendingCategories = failure.categories.flatMap((category: unknown) =>
            category &&
            typeof category === 'object' &&
            'name' in category &&
            typeof category.name === 'string'
              ? [category.name]
              : [],
          );
        throw new Error(
          ['DRAW_ENTRIES_CHANGED', 'NO_ACTIVE_CATEGORIES', 'TEAMS_NOT_READY'].includes(
            failure?.message,
          )
            ? failure.message
            : 'DOWNLOAD',
        );
      }
      if (!r.headers.get('content-type')?.includes('application/pdf')) throw new Error('DOWNLOAD');
      const url = URL.createObjectURL(await r.blob()),
        a = document.createElement('a');
      a.href = url;
      a.download = `${kind.toLowerCase()}-${scope === 'ALL' ? 'all' : chosen.length === 1 ? chosen[0] : 'selected'}-${tournamentId}-${lang}.pdf`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setDone(true);
    } catch (error) {
      setError(
        error instanceof Error && error.message === 'DRAW_ENTRIES_CHANGED'
          ? text(
              'Состав изменился. Повторите жеребьёвку затронутых категорий перед скачиванием сетки. Список участников можно скачать отдельно.',
              'Құрам өзгерді. Торды жүктемес бұрын тиісті санаттардың жеребесін қайталаңыз. Қатысушылар тізімін бөлек жүктеуге болады.',
            )
          : error instanceof Error && error.message === 'TEAMS_NOT_READY'
            ? `${text(
                'Категории ещё не готовы к итоговому зачёту. Проверьте подтверждение встреч и результаты.',
                'Санаттар қорытынды есепке әлі дайын емес. Белдесулердің расталуын және нәтижелерін тексеріңіз.',
              )}${pendingCategories.length ? ` ${pendingCategories.join(', ')}.` : ''}`
            : error instanceof Error && error.message === 'NO_ACTIVE_CATEGORIES'
              ? text(
                  'В выбранных категориях нет участников для этого документа. Можно скачать списки участников.',
                  'Таңдалған санаттарда бұл құжат үшін қатысушылар жоқ. Қатысушылар тізімін жүктеуге болады.',
                )
              : text(
                  'Не удалось скачать PDF. Проверьте подключение и повторите.',
                  'PDF жүктеу мүмкін болмады. Қосылымды тексеріп, қайталаңыз.',
                ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" onClick={open} disabled={busy}>
        {text('Скачать протоколы', 'Хаттамаларды жүктеу')} ↓
      </button>
      <dialog ref={dialog} className="protocol-export" aria-labelledby={titleId}>
        <header className="protocol-export-heading">
          <div>
            <p>JUDO CHILD LEAGUE</p>
            <h2 id={titleId}>{text('Скачать протоколы', 'Хаттамаларды жүктеу')}</h2>
          </div>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label={text('Закрыть', 'Жабу')}
          >
            ×
          </button>
        </header>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void download();
          }}
        >
          <fieldset disabled={busy}>
            <legend>1. {text('Какой документ нужен?', 'Қандай құжат қажет?')}</legend>
            <div className="protocol-export-kinds">
              {kinds.map(([value, ru, kk, descRu, descKk]) => (
                <label key={value} className={kind === value ? 'is-selected' : ''}>
                  <input
                    type="radio"
                    name={`${titleId}-kind`}
                    value={value}
                    checked={kind === value}
                    onChange={() => {
                      setKind(value);
                      setDone(false);
                    }}
                  />
                  <span>
                    <strong>{text(ru, kk)}</strong>
                    <small>{text(descRu, descKk)}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset disabled={busy || loading}>
            <legend>2. {text('Какие категории включить?', 'Қандай санаттарды қосу керек?')}</legend>
            <div className="protocol-export-scope">
              <label>
                <input
                  type="radio"
                  name={`${titleId}-scope`}
                  checked={scope === 'ALL'}
                  onChange={() => {
                    setScope('ALL');
                    setDone(false);
                  }}
                />
                {text('Весь турнир', 'Бүкіл турнир')} {!loading && `· ${eligible.length}`}
              </label>
              <label>
                <input
                  type="radio"
                  name={`${titleId}-scope`}
                  checked={scope === 'SELECTED'}
                  onChange={() => {
                    setScope('SELECTED');
                    setDone(false);
                  }}
                />
                {text('Выбрать категории', 'Санаттарды таңдау')}
              </label>
            </div>
            {loading ? (
              <p role="status">{text('Загружаем категории…', 'Санаттар жүктелуде…')}</p>
            ) : (
              scope === 'SELECTED' && (
                <div className="protocol-export-categories">
                  {categories.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={chosen.includes(c.id)}
                        disabled={kind !== 'PARTICIPANTS' && exportEntryCount(c) === 0}
                        onChange={(e) => {
                          setSelected((prev) =>
                            e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                          );
                          setDone(false);
                        }}
                      />
                      <span>{c.name}</span>
                      <small>{exportEntryCount(c)}</small>
                    </label>
                  ))}
                  {!categories.length && <p>{text('Категорий пока нет.', 'Санаттар әлі жоқ.')}</p>}
                </div>
              )
            )}
          </fieldset>
          {!loading && kind !== 'PARTICIPANTS' && categories.length > eligible.length && (
            <p role="status">
              {text(
                'Пустые категории не включаются в этот документ. Их настройки и история сохраняются; списки участников можно скачать отдельно.',
                'Бос санаттар бұл құжатқа қосылмайды. Баптаулар мен тарих сақталады; қатысушылар тізімін бөлек жүктеуге болады.',
              )}
            </p>
          )}
          <label className="protocol-export-language">
            <strong>3. {text('Язык документа', 'Құжат тілі')}</strong>
            <select
              value={lang}
              disabled={busy}
              onChange={(e) => {
                setLang(e.target.value as 'ru' | 'kk');
                setDone(false);
              }}
            >
              <option value="kk">Қазақша</option>
              <option value="ru">Русский</option>
            </select>
          </label>
          {error && (
            <p role="alert" className="protocol-export-error">
              {error}
            </p>
          )}
          {done && (
            <p role="status" className="protocol-export-success">
              {text(
                'PDF готов. Файл передан браузеру для скачивания.',
                'PDF дайын. Файл жүктеу үшін браузерге жіберілді.',
              )}
            </p>
          )}
          <footer className="protocol-export-actions">
            <span>
              {text('Один PDF · A4', 'Бір PDF · A4')} ·{' '}
              {scope === 'ALL'
                ? text('Весь турнир', 'Бүкіл турнир')
                : `${text('Категорий', 'Санаттар')}: ${chosen.length}`}
            </span>
            <button
              type="submit"
              disabled={
                busy || loading || !eligible.length || (scope === 'SELECTED' && !chosen.length)
              }
            >
              {busy ? text('Готовим PDF…', 'PDF дайындалуда…') : text('Скачать PDF', 'PDF жүктеу')}
            </button>
          </footer>
        </form>
      </dialog>
    </>
  );
}
