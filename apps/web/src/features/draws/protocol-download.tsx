'use client';
import { useId, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import './protocol-download.css';
const kinds = [
  [
    'DRAW',
    'Сетка',
    'Тор',
    'Сетка с линиями; для круговой — пары по турам.',
    'Сызықтары бар тор; айналмалы жүйеде — айналымдар бойынша жұптар.',
  ],
  [
    'PARTICIPANTS',
    'Все участники',
    'Барлық қатысушылар',
    'Списки по категориям: имя, год рождения и клуб.',
    'Санаттар бойынша тізімдер: аты-жөні, туған жылы және клубы.',
  ],
  [
    'BOUTS',
    'Схватки',
    'Белдесулер',
    'Все пары, подтверждённые оценки, время и победители.',
    'Барлық жұптар, расталған бағалар, уақыт және жеңімпаздар.',
  ],
  [
    'RESULTS',
    'Итоги категорий',
    'Санаттар қорытындысы',
    'Места спортсменов в завершённых категориях.',
    'Аяқталған санаттардағы спортшылардың орындары.',
  ],
  [
    'TEAMS',
    'Командный зачёт',
    'Командалық есеп',
    'Медали команд, составы и результаты участников.',
    'Командалардың медальдары, құрамы және қатысушылар нәтижелері.',
  ],
  [
    'MEDALS',
    'Медальный зачёт',
    'Медальдық есеп',
    'Краткая таблица: золото, серебро, бронза.',
    'Қысқаша кесте: алтын, күміс, қола.',
  ],
  [
    'ALL',
    'Все документы',
    'Барлық құжаттар',
    'Все шесть видов протоколов в одном PDF.',
    'Хаттамалардың барлық алты түрі бір PDF ішінде.',
  ],
] as const;
type Kind = (typeof kinds)[number][0];
const available = (kind: Kind) => kind === 'DRAW' || kind === 'PARTICIPANTS';
type ExportCategory = {
  id: string;
  name: string;
  _count?: { entries: number };
  entries?: unknown[];
};
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
    if (
      !available(kind) ||
      busy ||
      loading ||
      !categories.length ||
      (scope === 'SELECTED' && !selected.length)
    )
      return;
    setBusy(true);
    setError('');
    setDone(false);
    try {
      const query = new URLSearchParams({ lang, kind });
      if (scope === 'SELECTED') query.set('categoryIds', selected.join(','));
      const r = await fetch(`/api/v1/tournaments/${tournamentId}/protocol.pdf?${query}`, {
        cache: 'no-store',
      });
      if (!r.ok || !r.headers.get('content-type')?.includes('application/pdf'))
        throw new Error('DOWNLOAD');
      const url = URL.createObjectURL(await r.blob()),
        a = document.createElement('a');
      a.href = url;
      a.download = `${kind.toLowerCase()}-${scope === 'ALL' ? 'all' : selected.length === 1 ? selected[0] : 'selected'}-${tournamentId}-${lang}.pdf`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setDone(true);
    } catch {
      setError(
        text(
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
                <label
                  key={value}
                  className={
                    !available(value) ? 'is-unavailable' : kind === value ? 'is-selected' : ''
                  }
                >
                  <input
                    type="radio"
                    name={`${titleId}-kind`}
                    value={value}
                    disabled={!available(value)}
                    checked={kind === value}
                    onChange={() => {
                      setKind(value);
                      setDone(false);
                    }}
                  />
                  <span>
                    <strong>{text(ru, kk)}</strong>
                    <small>
                      {available(value)
                        ? text(descRu, descKk)
                        : text('Пока недоступно', 'Әзірге қолжетімсіз')}
                    </small>
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
                {text('Весь турнир', 'Бүкіл турнир')} {!loading && `· ${categories.length}`}
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
                        checked={selected.includes(c.id)}
                        onChange={(e) => {
                          setSelected((prev) =>
                            e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                          );
                          setDone(false);
                        }}
                      />
                      <span>{c.name}</span>
                      <small>{c._count?.entries ?? c.entries?.length ?? 0}</small>
                    </label>
                  ))}
                  {!categories.length && <p>{text('Категорий пока нет.', 'Санаттар әлі жоқ.')}</p>}
                </div>
              )
            )}
          </fieldset>
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
                : `${text('Категорий', 'Санаттар')}: ${selected.length}`}
            </span>
            <button
              type="submit"
              disabled={
                !available(kind) ||
                busy ||
                loading ||
                !categories.length ||
                (scope === 'SELECTED' && !selected.length)
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
