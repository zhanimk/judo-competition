'use client';
import { subscribeTournament } from '../../shared/live/subscribe';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import { formatLabel } from '../draws/format-label';
import { NEW_DRAW_FORMATS } from '@judo/engine/draw';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { ProtocolDownload } from '../draws/protocol-download';
import { DrawPanel } from '../draws/draw-panel';
import { ControlCenter } from '../control/control-center';
import { ClubRoster } from '../roster/club-roster';
import { readPendingRoster } from '../roster/roster-command';
import { acceptRosterSnapshot, mergeRosterReceipt, type Receipt } from '../roster/roster-model';
import Link from 'next/link';
import { request } from './api';
import type { Tournament } from './types';
import { startReadiness } from './start-readiness';
import styles from './tournament-workspace.module.css';
export function TournamentWorkspace({ id }: { id: string }) {
  const { text, locale } = useLanguage();
  const [t, setT] = useState<Tournament | null>(null),
    [tab, setTab] = useState('overview'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [rosterPending, setRosterPending] = useState(false);
  const pollerRef = useRef<{ refresh: () => Promise<void>; stop: () => void } | null>(null);
  const [category, setCategory] = useState({
    name: '',
    gender: 'MALE',
    format: 'REPECHAGE',
    birthYearFrom: 2012,
    birthYearTo: 2013,
    maxWeightGrams: 50000,
    durationSeconds: 180,
  });
  const [openWeight, setOpenWeight] = useState(false);
  async function load() {
    await pollerRef.current?.refresh();
  }
  const applyReceipt = useCallback(
    (receipt: Receipt) => {
      setT((current) => (current?.id === id ? mergeRosterReceipt(current, receipt) : current));
    },
    [id],
  );
  useEffect(() => {
    setT(null);
    setLoaded(false);
    setError('');
    setRosterPending(false);
    try {
      if (readPendingRoster(sessionStorage, id)) {
        setRosterPending(true);
        setTab('entries');
      }
    } catch {
      setRosterPending(true);
      setTab('entries');
    }
    const poller = pollSnapshots(
      () => request<Tournament>(`/tournaments/${id}`),
      (value) => {
        setT((current) => acceptRosterSnapshot(current, value, id));
        setLoaded(true);
        setError('');
      },
      (error) => {
        setError((error as Error).message);
        setLoaded(true);
      },
      5000,
    );
    pollerRef.current = poller;
    void poller.refresh();
    const unsubscribe = subscribeTournament(id, (event) => {
      if (event.kind !== 'state') void poller.refresh();
    });
    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
      unsubscribe();
    };
  }, [id]);
  async function start() {
    if (!t || busy || rosterPending) return;
    const readiness = startReadiness(t.categories);
    if (!readiness.ready) {
      setError(
        !readiness.active.length
          ? text(
              'Добавьте участников: пустые категории не участвуют в турнире.',
              'Қатысушыларды қосыңыз: бос санаттар турнирге қатыспайды.',
            )
          : readiness.single.length
            ? text(
                'В этих категориях только один участник: ',
                'Бұл санаттарда бір ғана қатысушы бар: ',
              ) +
              readiness.single.map((c) => c.name).join(', ') +
              text(
                '. Добавьте соперника или измените заявку до жеребьёвки.',
                '. Қарсылас қосыңыз немесе жеребеге дейін өтінімді өзгертіңіз.',
              )
            : text('Подтвердите сетки категорий: ', 'Санаттардың торларын растаңыз: ') +
              readiness.unconfirmed.map((c) => c.name).join(', '),
      );
      setTab(readiness.single.length || !readiness.active.length ? 'entries' : 'draw');
      return;
    }
    if (
      !window.confirm(
        text(
          'Запустить турнир? Составы будут заблокированы, готовые схватки распределены по татами. Таймеры запускаются отдельно в пультах.',
          'Турнирді бастау керек пе? Құрамдар бекітіліп, дайын белдесулер татамиге бөлінеді. Таймерлер пульттерде бөлек іске қосылады.',
        ) +
          (readiness.empty.length
            ? '\n\n' +
              text('Без участников, будут пропущены: ', 'Қатысушысыз, өткізілмейді: ') +
              readiness.empty.map((c) => c.name).join(', ')
            : ''),
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await request(`/tournaments/${id}/start`, {});
      await load();
      setTab('tatamis');
    } catch {
      setError(
        text(
          'Состав или сетки изменились. Обновите данные, проверьте категории с участниками и повторите запуск.',
          'Құрам немесе торлар өзгерді. Деректерді жаңартып, қатысушылары бар санаттарды тексеріңіз де, қайта бастаңыз.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    setBusy(true);
    setError('');
    try {
      await request(`/tournaments/${id}/publish`, {});
      await load();
    } catch {
      setError(text('Не удалось опубликовать турнир.', 'Турнирді жариялау мүмкін болмады.'));
    } finally {
      setBusy(false);
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request(`/tournaments/${id}/categories`, {
        ...category,
        maxWeightGrams: openWeight ? null : category.maxWeightGrams,
        minWeightGrams: openWeight ? category.maxWeightGrams : null,
      });
      setCategory({ ...category, name: '' });
      await load();
    } catch (e) {
      setError(
        (e as Error).message === 'DRAW_LOCKED'
          ? text(
              'Состав категории заблокирован после подтверждения сетки.',
              'Тор расталғаннан кейін санат құрамы бекітілді.',
            )
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  if (!t || t.id !== id)
    return (
      <div className="panel state-box">
        {loaded ? error : text('Загружаем турнир…', 'Турнир жүктелуде…')}
        {loaded && <button onClick={load}>{text('Повторить', 'Қайталау')}</button>}
      </div>
    );
  const entries = t.categories.flatMap((c) =>
    (c.entries ?? []).map((e) => ({ ...e, category: c.name })),
  );
  return (
    <>
      <Link className="back-link" href="/tournaments">
        ← {text('Все турниры', 'Барлық турнирлер')}
      </Link>
      <div className={styles.heading}>
        <div className={styles.details}>
          <p className="kicker">{text('РАБОЧАЯ ОБЛАСТЬ ТУРНИРА', 'ТУРНИРДІҢ ЖҰМЫС КЕҢІСТІГІ')}</p>
          <h1>{t.name}</h1>
          <p className={styles.location}>
            {t.city} · {t.venue} · {t.startDate} — {t.endDate}
          </p>
          <p className={styles.rules}>
            {text('Регламент', 'Ереже')}: {t.rulesSnapshot?.version ?? '—'} ·{' '}
            {t.rulesSnapshot?.approvedAt
              ? text('Версия зафиксирована при запуске', 'Нұсқа басталған кезде бекітілді')
              : text('Будет зафиксирован при запуске', 'Басталған кезде бекітіледі')}{' '}
            ·{' '}
            {t.rulesSnapshot?.tieBreak === 'REMATCH'
              ? text('При равенстве — дополнительные встречи', 'Тең болса — қосымша белдесулер')
              : text('Правила прежней версии', 'Алдыңғы нұсқа ережелері')}
          </p>
        </div>
        <div className={styles.actions}>
          {t.status === 'DRAFT' ? (
            <button className="solid-button" disabled={busy || rosterPending} onClick={start}>
              {text('Запустить турнир', 'Турнирді бастау')} →
            </button>
          ) : (
            <span className="draft">
              {t.status === 'RUNNING'
                ? text('Турнир идёт', 'Турнир өтуде')
                : text('Турнир завершён', 'Турнир аяқталды')}
            </span>
          )}
          {t.publishedAt ? (
            <Link className={styles.publish} href={`/public/tournaments/${id}`}>
              {text('Страница для зрителей ↗', 'Көрермендер беті ↗')}
            </Link>
          ) : (
            <button className={styles.publish} disabled={busy || rosterPending} onClick={publish}>
              {text('Опубликовать турнир', 'Турнирді жариялау')}
            </button>
          )}
        </div>
      </div>
      <nav className="tabs" aria-label={text('Разделы турнира', 'Турнир бөлімдері')}>
        {[
          ['overview', text('Обзор', 'Шолу')],
          ['categories', text('Категории', 'Санаттар')],
          ['entries', text('Участники', 'Қатысушылар')],
          ['draw', text('Жеребьёвка', 'Жеребе')],
          ['tatamis', text('Центр татами', 'Татами орталығы')],
          ['protocols', text('Протоколы', 'Хаттамалар')],
        ].map(([value, label]) => (
          <button
            key={value}
            aria-current={tab === value ? 'page' : undefined}
            className={tab === value ? 'active' : ''}
            disabled={rosterPending && tab !== value}
            onClick={() => {
              setTab(value);
              setError('');
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {tab === 'overview' && (
        <>
          <div className="metric-grid">
            <div>
              <span>{text('Категории', 'Санаттар')}</span>
              <strong>{t.categories.length}</strong>
              <small>{text('Возрастные и весовые группы', 'Жас және салмақ топтары')}</small>
            </div>
            <div>
              <span>{text('Участники', 'Қатысушылар')}</span>
              <strong>{entries.length}</strong>
              <small>{text('Заявки в базе данных', 'Дерекқордағы қатысушылар')}</small>
            </div>
            <div>
              <span>{text('Татами', 'Татами')}</span>
              <strong>{t.tatamiCount}</strong>
              <small>{text('Задано организатором', 'Ұйымдастырушы белгілеген')}</small>
            </div>
          </div>
          <section className="panel checklist">
            <h2>{text('Управление турниром', 'Турнирді басқару')}</h2>
            <button onClick={() => setTab('categories')}>
              <span>{t.categories.length ? '✓' : '01'}</span>
              <div>
                <strong>{text('Категории', 'Санаттар')}</strong>
                <p>
                  {text(
                    'Пол, возраст, вес и продолжительность схватки',
                    'Жынысы, жасы, салмағы және белдесу ұзақтығы',
                  )}
                </p>
              </div>
              <b>→</b>
            </button>
            <button onClick={() => setTab('entries')}>
              <span>{entries.length ? '✓' : '02'}</span>
              <div>
                <strong>{text('Участники', 'Қатысушылар')}</strong>
                <p>
                  {text(
                    'Имя, клуб и категория с проверкой возраста',
                    'Аты, клубы және жасы тексерілетін санат',
                  )}
                </p>
              </div>
              <b>→</b>
            </button>
            <button onClick={() => setTab('draw')}>
              <span>
                {t.categories.length > 0 &&
                t.categories.every((c) => c.draw?.status === 'CONFIRMED')
                  ? '✓'
                  : '03'}
              </span>
              <div>
                <strong>
                  {text('Жеребьёвка и публикация сеток', 'Жеребе және торларды жариялау')}
                </strong>
                <p>
                  {text(
                    'Проверьте пары, клубы и выбранную систему',
                    'Жұптарды, клубтарды және жүйені тексеріңіз',
                  )}
                </p>
              </div>
              <b>→</b>
            </button>
            <button onClick={() => setTab('tatamis')}>
              <span>04</span>
              <div>
                <strong>
                  {text('Управление татами и пульты', 'Татамиді басқару және пульттер')}
                </strong>
                <p>
                  {text(
                    'Каждое татами: пульт, экран и приглашение оператору',
                    'Әр татами: пульт, экран және операторға шақыру',
                  )}
                </p>
              </div>
              <b>→</b>
            </button>
            <button onClick={() => setTab('protocols')}>
              <span>05</span>
              <div>
                <strong>{text('Результаты и протоколы', 'Нәтижелер және хаттамалар')}</strong>
                <p>
                  {text(
                    'Подтверждённый результат автоматически обновляет сайт и PDF',
                    'Расталған нәтиже сайт пен PDF деректерін автоматты жаңартады',
                  )}
                </p>
              </div>
              <b>→</b>
            </button>
          </section>
        </>
      )}
      {tab === 'categories' && (
        <div className="detail-grid">
          <section className="panel">
            <div className="panel-heading">
              <h2>{text('Категории', 'Санаттар')}</h2>
              <span>{t.categories.length}</span>
            </div>
            {!t.categories.length ? (
              <p className="state-box">
                {text(
                  'Добавьте первую категорию с помощью формы.',
                  'Нысан арқылы алғашқы санатты қосыңыз.',
                )}
              </p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{text('Категория', 'Санат')}</th>
                      <th>{text('Годы', 'Жылдар')}</th>
                      <th>{text('Вес', 'Салмақ')}</th>
                      <th>{text('Время', 'Уақыт')}</th>
                      <th>{text('Формат', 'Формат')}</th>
                      <th>{text('Участники', 'Қатысушылар')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.categories.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>{c.name}</strong>
                          <small>
                            {c.gender === 'MALE'
                              ? text('Юноши / мужчины', 'Ұлдар / ерлер')
                              : text('Девушки / женщины', 'Қыздар / әйелдер')}
                          </small>
                        </td>
                        <td>
                          {c.birthYearFrom}–{c.birthYearTo}
                        </td>
                        <td>
                          {c.maxWeightGrams === null
                            ? `+${(c.minWeightGrams ?? 0) / 1000}`
                            : `−${c.maxWeightGrams / 1000}`}{' '}
                          кг
                        </td>
                        <td>{c.durationSeconds / 60} мин</td>
                        <td>{formatLabel(c.format, locale)}</td>
                        <td>{c.entries?.length ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <form className="panel form-panel" onSubmit={save}>
            <h2>{text('Новая категория', 'Жаңа санат')}</h2>
            <label>
              {text('Название', 'Атауы')}
              <input
                required
                minLength={2}
                maxLength={100}
                placeholder={text('Юноши U15 · −50 кг', 'Ұлдар U15 · −50 кг')}
                value={category.name}
                onChange={(e) => setCategory({ ...category, name: e.target.value })}
              />
            </label>
            <label>
              {text('Пол', 'Жынысы')}
              <select
                value={category.gender}
                onChange={(e) => setCategory({ ...category, gender: e.target.value })}
              >
                <option value="MALE">{text('Мужской', 'Ер')}</option>
                <option value="FEMALE">{text('Женский', 'Әйел')}</option>
              </select>
            </label>
            <div className="form-two">
              <label>
                {text('Год рождения от', 'Туған жылы, бастап')}
                <input
                  type="number"
                  min={1900}
                  max={2100}
                  required
                  value={category.birthYearFrom}
                  onChange={(e) => setCategory({ ...category, birthYearFrom: +e.target.value })}
                />
              </label>
              <label>
                {text('До', 'Дейін')}
                <input
                  type="number"
                  min={category.birthYearFrom}
                  max={2100}
                  required
                  value={category.birthYearTo}
                  onChange={(e) => setCategory({ ...category, birthYearTo: +e.target.value })}
                />
              </label>
            </div>
            <label>
              {text('Граница веса', 'Салмақ шегі')}
              <select
                value={openWeight ? 'OVER' : 'UP_TO'}
                onChange={(e) => setOpenWeight(e.target.value === 'OVER')}
              >
                <option value="UP_TO">
                  {text('До указанного веса (−)', 'Көрсетілген салмаққа дейін (−)')}
                </option>
                <option value="OVER">
                  {text('Свыше указанного веса (+)', 'Көрсетілген салмақтан жоғары (+)')}
                </option>
              </select>
            </label>
            <label>
              {openWeight
                ? text('Нижняя граница веса, кг', 'Салмақтың төменгі шегі, кг')
                : text('Верхняя граница веса, кг', 'Салмақтың жоғарғы шегі, кг')}
              <input
                type="number"
                min={1}
                max={300}
                step="0.1"
                required
                value={category.maxWeightGrams / 1000}
                onChange={(e) =>
                  setCategory({ ...category, maxWeightGrams: Math.round(+e.target.value * 1000) })
                }
              />
            </label>
            <label>
              {text('Время схватки, секунд', 'Белдесу уақыты, секунд')}
              <input
                type="number"
                min={30}
                max={1200}
                required
                value={category.durationSeconds}
                onChange={(e) => setCategory({ ...category, durationSeconds: +e.target.value })}
              />
            </label>
            <label>
              {text('Система проведения', 'Өткізу жүйесі')}
              <select
                value={category.format}
                onChange={(e) => setCategory({ ...category, format: e.target.value })}
              >
                {NEW_DRAW_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {formatLabel(format, locale)}
                    {format === 'MIXED' ? text(' · с утешением', ' · жұбанышпен') : ''}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-note">
              {text(
                '2–7 участников — круговая автоматически. От 8 — выбранная система. Олимпийская и смешанная: утешение от четвертьфинала и два третьих места. Пользовательский регламент.',
                '2–7 қатысушы — автоматты түрде айналмалы жүйе. 8-ден бастап — таңдалған жүйе. Олимпиадалық және аралас: ширек финалдан жұбаныш және екі үшінші орын. Бапталатын ереже.',
              )}
            </p>
            <button className="solid-button" disabled={busy || t.status !== 'DRAFT'}>
              {busy ? text('Сохраняем…', 'Сақталуда…') : text('Добавить категорию', 'Санатты қосу')}
            </button>
          </form>
        </div>
      )}
      {tab === 'entries' && (
        <ClubRoster
          key={t.id}
          tournament={t}
          onUpdate={load}
          onCommitted={applyReceipt}
          onPendingChange={setRosterPending}
        />
      )}
      {tab === 'tatamis' && <ControlCenter tournamentId={t.id} />}
      {tab === 'draw' && <DrawPanel key={t.id} tournament={t} onUpdate={load} />}
      {tab === 'protocols' && (
        <section className="panel empty-state">
          <div className="empty-symbol">▤</div>
          <h3>{text('Документы турнира', 'Турнир құжаттары')}</h3>
          <p>
            {text(
              'Сетки и результаты, участники по категориям. Командный зачёт по медалям пока недоступен. Выберите документ, категории и язык.',
              'Торлар мен нәтижелер, санаттар бойынша қатысушылар. Медальдар бойынша командалық есеп әзірге қолжетімсіз. Құжатты, санаттарды және тілді таңдаңыз.',
            )}
          </p>
          <ProtocolDownload tournamentId={id} />
          <Link className="solid-link" href={`/tournaments/${id}/protocol`}>
            {text('Открыть протокол', 'Хаттаманы ашу')}
          </Link>
        </section>
      )}
    </>
  );
}
