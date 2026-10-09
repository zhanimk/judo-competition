'use client';
import { Brand } from '../../components/layout/brand';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PublicParticipants } from './public-participants';
import { SpectatorQueue } from './spectator-queue';
import type { Draw } from '@judo/engine/draw';
import { PublicResults } from './public-results';
import { ResultsTable, type ResultContest } from '../live/results-table';
import { LiveBoard } from '../live/live-board';
import { subscribeTournament } from '../../shared/live/subscribe';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import { ApiError, request } from '../tournaments/api';
import type { Entry } from '../tournaments/types';
import { LanguageSwitch, useLanguage } from '../../shared/i18n/provider';
import { type QueueItem } from '../tatamis/queue-view';
import { CompetitionDraw } from '../draws/competition-draw';

import '../../components/layout/platform.css';
import './public.css';
type Summary = {
  id: string;
  name: string;
  city: string;
  venue: string;
  startDate: string;
  endDate: string;
  tatamiCount: number;
};
export type PublicTournament = Summary & {
  tatamis: { id: string; number: number; queue: QueueItem[] }[];
  categories: {
    id: string;
    name: string;
    format: string;
    entries: Entry[];
    draw: null | {
      snapshot: Draw;
      contests: (ResultContest & { tatamiId: string | null })[];
    };
  }[];
};
function Frame({ children }: { children: ReactNode }) {
  const { text } = useLanguage();
  return (
    <div className="platform public-site">
      <a className="skip-link" href="#public-content">
        {text('К содержимому', 'Мазмұнға өту')}
      </a>
      <header className="public-header">
        <Link href="/public" className="public-brand">
          <Brand />
        </Link>
        <div className="public-header-tools">
          <Link href="/login" className="public-admin-login">
            {text('Вход администратора', 'Әкімшіге кіру')}
          </Link>
          <LanguageSwitch />
        </div>
      </header>
      <main id="public-content" className="public-main">
        {children}
      </main>
      <footer className="public-footer">
        <span>Judo Child League</span>
        <Link href="/login">{text('Вход для организаторов', 'Ұйымдастырушыларға кіру')}</Link>
      </footer>
    </div>
  );
}
export function PublicCatalog() {
  const { text } = useLanguage();
  const [rows, setRows] = useState<Summary[] | null>(null),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    request<Summary[]>('/public/tournaments')
      .then((r) => {
        if (active) setRows(r);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [retry]);
  return (
    <Frame>
      <div className="public-hero">
        <p className="kicker">JUDO · {text('ДЛЯ ЗРИТЕЛЕЙ', 'КӨРЕРМЕНДЕРГЕ')}</p>
        <h1>{text('Выберите соревнование', 'Жарысты таңдаңыз')}</h1>
        <p>
          {text(
            'Схватки, участники и результаты. Регистрация не нужна.',
            'Белдесулер, қатысушылар және нәтижелер. Тіркелу қажет емес.',
          )}
        </p>
      </div>
      {error ? (
        <p className="error-box" role="alert">
          {text('Не удалось загрузить турниры.', 'Турнирлерді жүктеу мүмкін болмады.')}{' '}
          <button onClick={() => setRetry((v) => v + 1)}>{text('Повторить', 'Қайталау')}</button>
        </p>
      ) : !rows ? (
        <p role="status">{text('Загрузка…', 'Жүктелуде…')}</p>
      ) : !rows.length ? (
        <section className="panel state-box">
          {text('Опубликованных турниров пока нет.', 'Жарияланған турнирлер әлі жоқ.')}
        </section>
      ) : (
        <div className="public-tournaments">
          {rows.map((t) => (
            <Link
              className="panel public-tournament-card"
              href={`/public/tournaments/${t.id}`}
              key={t.id}
            >
              <span className="draft">{t.startDate}</span>
              <h2>{t.name}</h2>
              <p>
                {t.city} · {t.venue}
              </p>
              <span>
                {text('Открыть соревнование', 'Жарысты ашу')} <b aria-hidden="true">→</b>
              </span>
            </Link>
          ))}
        </div>
      )}
    </Frame>
  );
}
export function PublicHub({ id, resultsOnly = false }: { id: string; resultsOnly?: boolean }) {
  const { text } = useLanguage();
  const params = useSearchParams();
  const requestedTab = params.get('view');
  const tab = resultsOnly
    ? 'results'
    : requestedTab === 'entries' || requestedTab === 'draw'
      ? requestedTab
      : 'tatamis';
  const [drawMode, setDrawMode] = useState('bracket');
  useEffect(() => {
    if (window.matchMedia('(max-width: 640px)').matches) setDrawMode('list');
  }, []);
  const [t, setT] = useState<PublicTournament | null>(null),
    [error, setError] = useState(false),
    [matId, setMatId] = useState(''),
    [categoryId, setCategoryId] = useState(''),
    [updated, setUpdated] = useState<Date | null>(null);
  useEffect(() => {
    setT(null);
    setError(false);
    setUpdated(null);
    const poller = pollSnapshots(
      () => request<PublicTournament>(`/public/tournaments/${id}`),
      (r) => {
        setT(r);
        setError(false);
        setUpdated(new Date());
      },
      (error) => {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setT(null);
          setUpdated(null);
        }
        setError(true);
      },
      5000,
    );
    const unsubscribe = subscribeTournament(id, (e) => {
      if (e.kind !== 'state') void poller.refresh();
    });
    void poller.refresh();
    return () => {
      unsubscribe();
      poller.stop();
    };
  }, [id]);
  const mat = t?.tatamis.find((m) => m.id === matId) ?? t?.tatamis[0];
  const category =
    t?.categories.find((c) => c.id === (categoryId || params.get('category'))) ?? t?.categories[0];
  useEffect(() => {
    setCategoryId('');
  }, [params]);
  const entries =
    t?.categories.flatMap((c) =>
      c.entries.map((e) => ({ ...e, category: c.name, categoryId: c.id })),
    ) ?? [];
  const DrawView = CompetitionDraw;
  return (
    <Frame>
      <Link className="back-link" href="/public">
        ← {text('Все турниры', 'Барлық турнирлер')}
      </Link>
      {error && (
        <p className="error-box" role="alert">
          {t
            ? text(
                'Связь потеряна. Показаны последние полученные данные; повторяем подключение.',
                'Байланыс үзілді. Соңғы алынған деректер көрсетілген; қайта қосылудамыз.',
              )
            : text(
                'Турнир не опубликован или недоступен.',
                'Турнир жарияланбаған немесе қолжетімсіз.',
              )}
        </p>
      )}
      {!t ? (
        !error && <p role="status">{text('Загружаем турнир…', 'Турнир жүктелуде…')}</p>
      ) : (
        <>
          <div className="public-hero compact">
            <h1>{t.name}</h1>
            <p>
              {t.city} · {t.venue}
              <span className="public-date">
                {t.startDate.split('-').reverse().join('.')}{' '}
                {t.endDate !== t.startDate && '— ' + t.endDate.split('-').reverse().join('.')}
              </span>
            </p>
            <div className="public-facts">
              <span>
                <b>{entries.length}</b> {text('участников', 'қатысушы')}
              </span>
              <span>
                <b>{t.categories.length}</b> {text('категорий', 'санат')}
              </span>
              <span>
                <b>{t.tatamis.length}</b> {text('татами', 'татами')}
              </span>
            </div>
          </div>
          <nav className="spectator-nav" aria-label={text('Разделы турнира', 'Турнир бөлімдері')}>
            {[
              ['tatamis', text('Смотреть схватки', 'Белдесулерді көру')],
              ['entries', text('Участники', 'Қатысушылар')],
              ['draw', text('Сетки', 'Торлар')],
              ['results', text('Результаты', 'Нәтижелер')],
            ].map(([key, label]) => (
              <Link
                key={key}
                aria-current={tab === key ? 'page' : undefined}
                href={
                  key === 'results'
                    ? `/public/tournaments/${id}/results`
                    : `/public/tournaments/${id}?view=${key}`
                }
                scroll={false}
              >
                {label}
              </Link>
            ))}
          </nav>
          {resultsOnly ? (
            <PublicResults tournament={t} />
          ) : (
            <>
              {tab === 'tatamis' && (
                <>
                  <div className="spectator-section-heading">
                    <h2>{text('Выберите татами', 'Татамиді таңдаңыз')}</h2>
                    <span>
                      {text('Оценки обновляются автоматически', 'Бағалар автоматты жаңарады')}
                    </span>
                  </div>
                  <div
                    className="public-mats"
                    role="group"
                    aria-label={text('Выбор татами', 'Татами таңдау')}
                  >
                    {t.tatamis.map((m) => (
                      <button
                        className={mat?.id === m.id ? 'selected' : ''}
                        key={m.id}
                        aria-pressed={mat?.id === m.id}
                        onClick={() => setMatId(m.id)}
                      >
                        <span>ТАТАМИ {m.number}</span>
                        <small>
                          {mat?.id === m.id
                            ? text('✓ Вы смотрите', '✓ Көріп отырсыз')
                            : text('Смотреть →', 'Көру →')}
                        </small>
                      </button>
                    ))}
                  </div>
                  {!mat && (
                    <p className="spectator-empty">
                      {text(
                        'Татами появятся после настройки турнира.',
                        'Татами турнир бапталғаннан кейін пайда болады.',
                      )}
                    </p>
                  )}
                  {mat && (
                    <>
                      <section
                        className="spectator-live"
                        aria-label={`${text('Табло татами', 'Татами таблосы')} ${mat.number}`}
                      >
                        <LiveBoard key={mat.id} tatamiId={mat.id} />
                      </section>
                      <SpectatorQueue key={mat.id} items={mat.queue} />
                    </>
                  )}
                </>
              )}
              {tab === 'entries' && <PublicParticipants tournament={t} />}
              {tab === 'draw' && (
                <section className="spectator-section public-draw-panel">
                  <h2>{text('Сетка категории', 'Санат торы')}</h2>
                  <label>
                    {text('Категория', 'Санат')}
                    <select
                      value={category?.id ?? ''}
                      onChange={(e) => setCategoryId(e.target.value)}
                    >
                      {t.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} · {c.entries.length}
                        </option>
                      ))}
                    </select>
                  </label>
                  {category?.draw ? (
                    <>
                      <div
                        className="spectator-view-switch"
                        role="group"
                        aria-label={text('Вид жеребьёвки', 'Жеребе көрінісі')}
                      >
                        <button
                          aria-pressed={drawMode === 'bracket'}
                          onClick={() => setDrawMode('bracket')}
                        >
                          {text('Сетка', 'Тор')}
                        </button>
                        <button
                          aria-pressed={drawMode === 'list'}
                          onClick={() => setDrawMode('list')}
                        >
                          {text('Список схваток', 'Белдесулер тізімі')}
                        </button>
                      </div>
                      <DrawView
                        listView={drawMode === 'list'}
                        key={category.id}
                        draw={category.draw.snapshot}
                        entries={category.entries}
                        contests={category.draw.contests}
                        tatamis={t.tatamis}
                        busy={false}
                        canAssign={false}
                        readOnly
                        onAssign={() => {}}
                      />
                      <details className="draw-bottom-section">
                        <summary>{text('Результаты схваток', 'Белдесу нәтижелері')}</summary>
                        <ResultsTable
                          entries={category.entries}
                          contests={category.draw.contests}
                        />
                      </details>
                    </>
                  ) : (
                    <p className="state-box">
                      {text(
                        'Организатор ещё не опубликовал сетку этой категории.',
                        'Ұйымдастырушы бұл санаттың торын әлі жариялаған жоқ.',
                      )}
                    </p>
                  )}
                </section>
              )}
            </>
          )}
          <p className="public-update">
            {text('Данные обновлены', 'Деректер жаңартылды')} ·{' '}
            {updated?.toLocaleTimeString(text('ru-RU', 'kk-KZ'))}
          </p>
        </>
      )}
    </Frame>
  );
}
