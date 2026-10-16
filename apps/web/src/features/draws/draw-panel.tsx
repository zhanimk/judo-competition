'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { TatamiPlan } from '../tournaments/tatami-plan';
import './draw-workspace.css';
import { formatLabel } from './format-label';
import { ResultsTable } from '../live/results-table';
import { subscribeTournament } from '../../shared/live/subscribe';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import { useEffect, useRef, useState } from 'react';
import { drawFormat, type Draw } from '@judo/engine/draw';

import {
  clearPendingDraw,
  deliverPendingDraw,
  readPendingDraw,
  savePendingDraw,
  type PendingDraw,
} from './pending-draw';
import { TiebreakReview } from './tiebreak-review';
import { WithdrawEntry } from './withdraw-entry';
import { ProtocolDownload } from './protocol-download';
import { CompetitionDraw } from './competition-draw';
import { request } from '../tournaments/api';
import { useLanguage } from '../../shared/i18n/provider';
import type { Tournament } from '../tournaments/types';
import { activeEntryCount } from '../tournaments/start-readiness';
import {
  clearPendingAssignment,
  deliverPendingAssignment,
  mergeAssignmentReceipt,
  readPendingAssignment,
  savePendingAssignment,
  type AssignmentReceipt,
  type PendingAssignment,
} from './pending-assignment';
type SavedDraw = {
  id: string;
  version: number;
  status: string;
  publishedAt: string | null;
  publicationRevision: number;
  snapshot: Draw;
  contests: {
    id: string;
    key: string;
    revision: number;
    status: string;
    tatamiId: string | null;
  }[];
};
export function DrawPanel({
  tournament,
  onUpdate,
  administrationBlocked = false,
  onSchedule,
}: {
  tournament: Tournament;
  onUpdate: () => Promise<void>;
  administrationBlocked?: boolean;
  onSchedule: () => Promise<void>;
}) {
  const { text, locale } = useLanguage();
  const searchParams = useSearchParams();
  const requestedCategory = searchParams.get('category');
  const [refresh, setRefresh] = useState(0);
  useEffect(
    () =>
      subscribeTournament(tournament.id, (e) => {
        if (e.kind !== 'state') setRefresh((v) => v + 1);
      }),
    [tournament.id],
  );
  const [categoryId, setCategoryId] = useState(
    tournament.categories.some((c) => c.id === requestedCategory)
      ? requestedCategory!
      : (tournament.categories[0]?.id ?? ''),
  );
  useEffect(() => {
    if (requestedCategory && tournament.categories.some((c) => c.id === requestedCategory))
      setCategoryId(requestedCategory);
  }, [requestedCategory]);
  const [draw, setDraw] = useState<SavedDraw | null>(null),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [loadError, setLoadError] = useState(''),
    [pending, setPending] = useState<PendingAssignment | null>(null),
    [pendingRestored, setPendingRestored] = useState(false),
    [storageError, setStorageError] = useState(false),
    [tiePending, setTiePending] = useState(false),
    [withdrawalPending, setWithdrawalPending] = useState(false),
    [pendingDraw, setPendingDraw] = useState<PendingDraw | null>(null);
  const pendingRef = useRef<PendingAssignment | null>(null),
    pendingDrawRef = useRef<PendingDraw | null>(null),
    mutationLock = useRef(false),
    snapshotGeneration = useRef(0);
  const externalBlocked =
    administrationBlocked || busy || !!pending || !!pendingDraw || !pendingRestored || storageError;
  const blocked = externalBlocked || tiePending || withdrawalPending;

  const DrawView = CompetitionDraw;
  const category = tournament.categories.find((c) => c.id === categoryId);
  const tatamiId = category?.homeTatamiId ?? '';
  const mat = tournament.tatamis?.find((m) => m.id === tatamiId);
  useEffect(() => {
    setPendingRestored(false);
    setStorageError(false);
    try {
      const saved = readPendingAssignment(sessionStorage, tournament.id);
      pendingRef.current = saved;
      setPending(saved);
      const savedDraw = readPendingDraw(sessionStorage, tournament.id);
      if (saved && savedDraw) throw new Error('MULTIPLE_PENDING_COMMANDS');
      pendingDrawRef.current = savedDraw;
      setPendingDraw(savedDraw);
      setCategoryId(
        saved?.categoryId ?? savedDraw?.categoryId ?? tournament.categories[0]?.id ?? '',
      );
      setPendingRestored(true);
    } catch {
      setStorageError(true);
    }
  }, [tournament.id]);
  useEffect(() => {
    if (!pending && !pendingDraw) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [!!pending, !!pendingDraw]);
  useEffect(() => {
    setDraw(null);
    setLoading(true);
  }, [categoryId]);
  useEffect(() => {
    const generation = ++snapshotGeneration.current;
    setLoadError('');
    if (!categoryId) {
      setLoading(false);
      return;
    }
    const poller = pollSnapshots(
      () => request<{ draw: SavedDraw | null }>(`/categories/${categoryId}/draw`),
      (value) => {
        if (generation !== snapshotGeneration.current) return;
        setDraw(value.draw);
        setLoadError('');
        setLoading(false);
      },
      () => {
        if (generation !== snapshotGeneration.current) return;
        setLoadError(
          text(
            'Не удалось обновить сетку. Показана последняя полученная версия.',
            'Торды жаңарту мүмкін болмады. Соңғы алынған нұсқа көрсетілген.',
          ),
        );
        setLoading(false);
      },
      5000,
    );
    void poller.refresh();
    return () => poller.stop();
  }, [categoryId, refresh]);
  async function finishMutation() {
    snapshotGeneration.current++;
    setRefresh((value) => value + 1);
    try {
      await onUpdate();
    } catch {
      setLoadError(
        text(
          'Не удалось обновить турнир. Обновите сетку для проверки сохранённых данных.',
          'Турнирді жаңарту мүмкін болмады. Сақталған деректерді тексеру үшін торды жаңартыңыз.',
        ),
      );
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function assign(matchId: string) {
    if (
      mutationLock.current ||
      pendingRef.current ||
      pendingDrawRef.current ||
      administrationBlocked ||
      !pendingRestored ||
      storageError ||
      tiePending
    )
      return;
    const match = draw?.contests.find((contest) => contest.id === matchId);
    if (!match || match.status !== 'READY' || draw?.status !== 'CONFIRMED' || !tatamiId) return;
    const command: PendingAssignment = {
      tournamentId: tournament.id,
      categoryId,
      contestId: matchId,
      payload: { id: crypto.randomUUID(), expectedRevision: match.revision, tatamiId },
    };
    try {
      savePendingAssignment(sessionStorage, command);
      pendingRef.current = command;
      setPending(command);
    } catch {
      setError(
        text(
          'Назначение не отправлено: не удалось сохранить команду на этом устройстве.',
          'Тағайындау жіберілмеді: команданы осы құрылғыда сақтау мүмкін болмады.',
        ),
      );
      return;
    }
    await executeAssignment(command);
  }
  async function executeAssignment(command: PendingAssignment) {
    if (mutationLock.current || pendingRef.current?.payload.id !== command.payload.id) return;
    mutationLock.current = true;
    snapshotGeneration.current++;
    setBusy(true);
    setError('');
    try {
      const result = await deliverPendingAssignment(command, (contestId, payload) =>
        request<AssignmentReceipt>(`/contests/${contestId}/assign`, payload),
      );
      snapshotGeneration.current++;
      if (result.kind === 'success') {
        setDraw((current) =>
          current
            ? {
                ...current,
                contests: mergeAssignmentReceipt(current.contests, result.receipt),
              }
            : current,
        );
      }
      if (result.kind !== 'retry') {
        clearPendingAssignment(sessionStorage, command);
        pendingRef.current = null;
        setPending(null);
      }
      if (result.kind === 'rejected') {
        const code = result.error instanceof Error ? result.error.message : '';
        setError(
          code === 'VERSION_CONFLICT'
            ? text(
                'Назначение изменилось в другом окне. Проверьте обновлённую сетку и выберите действие заново.',
                'Тағайындау басқа терезеде өзгерді. Жаңартылған торды тексеріп, әрекетті қайта таңдаңыз.',
              )
            : text(
                'Назначение отклонено. Проверьте обновлённую сетку: ',
                'Тағайындау қабылданбады. Жаңартылған торды тексеріңіз: ',
              ) + code,
        );
      } else if (result.kind === 'retry') {
        setError(
          text(
            'Ответ не получен. Назначение могло сохраниться на сервере. Повторите сохранённую команду кнопкой ниже.',
            'Жауап алынбады. Тағайындау серверде сақталған болуы мүмкін. Төмендегі батырмамен сақталған команданы қайталаңыз.',
          ),
        );
      }
    } catch {
      setError(
        text(
          'Не удалось очистить сохранённую команду. Повторите её для проверки результата.',
          'Сақталған команданы тазалау мүмкін болмады. Нәтижесін тексеру үшін қайталаңыз.',
        ),
      );
    } finally {
      await finishMutation();
    }
  }
  async function executeDraw(command: PendingDraw) {
    if (mutationLock.current || pendingDrawRef.current?.payload.id !== command.payload.id) return;
    mutationLock.current = true;
    snapshotGeneration.current++;
    setBusy(true);
    setError('');
    try {
      const result = await deliverPendingDraw(command, (path, payload) => request(path, payload));
      if (result.kind !== 'retry') {
        clearPendingDraw(sessionStorage, command);
        pendingDrawRef.current = null;
        setPendingDraw(null);
      }
      if (result.kind === 'retry') {
        setError(
          text(
            'Ответ не получен. Изменение могло сохраниться. Повторите исходную команду ниже для проверки результата.',
            'Жауап алынбады. Өзгеріс сақталған болуы мүмкін. Нәтижесін тексеру үшін төмендегі бастапқы команданы қайталаңыз.',
          ),
        );
      } else if (result.kind === 'rejected') {
        const code = result.error instanceof Error ? result.error.message : '';
        setError(
          text(
            'Действие отклонено. Проверьте обновлённую сетку: ',
            'Әрекет қабылданбады. Жаңартылған торды тексеріңіз: ',
          ) + code,
        );
      }
      // A saved receipt can describe an older version. Reload current server
      // state instead of replacing the screen with its historical response.
    } catch {
      setError(
        text(
          'Не удалось очистить исходную команду. Повторите её для проверки результата.',
          'Бастапқы команданы тазалау мүмкін болмады. Нәтижесін тексеру үшін қайталаңыз.',
        ),
      );
    } finally {
      await finishMutation();
    }
  }
  async function action(kind: 'preview' | 'confirm' | 'publication') {
    if (
      mutationLock.current ||
      pendingRef.current ||
      pendingDrawRef.current ||
      !pendingRestored ||
      storageError ||
      tiePending ||
      administrationBlocked ||
      !categoryId
    )
      return;
    if (kind !== 'preview' && !draw) return;
    const base = { tournamentId: tournament.id, categoryId };
    const id = crypto.randomUUID();
    const command: PendingDraw =
      kind === 'preview'
        ? { ...base, operation: kind, payload: { id, expectedVersion: draw?.version ?? 0 } }
        : kind === 'confirm'
          ? { ...base, operation: kind, payload: { id, version: draw!.version } }
          : {
              ...base,
              operation: kind,
              payload: {
                id,
                expectedRevision: draw!.publicationRevision,
                published: !draw!.publishedAt,
              },
            };
    try {
      savePendingDraw(sessionStorage, command);
      pendingDrawRef.current = command;
      setPendingDraw(command);
    } catch {
      setError(
        text(
          'Команда не отправлена: не удалось сохранить её на устройстве.',
          'Команда жіберілмеді: оны құрылғыда сақтау мүмкін болмады.',
        ),
      );
      return;
    }
    await executeDraw(command);
  }
  function exportDraw(command: PendingDraw) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(command, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `judo-draw-command-${command.payload.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="draw-workspace">
      <header className="draw-section-heading">
        <div>
          <p className="kicker">{text('ПОДГОТОВКА И ПУБЛИКАЦИЯ', 'ДАЙЫНДАУ ЖӘНЕ ЖАРИЯЛАУ')}</p>
          <h2>{text('Жеребьёвка', 'Жеребе')}</h2>
        </div>
        <ProtocolDownload tournamentId={tournament.id} categoryId={categoryId || undefined} />
      </header>
      <TatamiPlan tournament={tournament} onSchedule={onSchedule} disabled={blocked} />
      {storageError && (
        <p role="alert" className="error-box">
          {text(
            'Не удалось восстановить сохранённые команды. Новые изменения заблокированы: проверьте доступ к хранилищу браузера и перезагрузите страницу.',
            'Сақталған тағайындауды қалпына келтіру мүмкін болмады. Жаңа өзгерістер бұғатталған: браузер қоймасына рұқсатты тексеріп, бетті қайта жүктеңіз.',
          )}
        </p>
      )}
      {pending && (
        <section className="panel" role="status">
          <p>
            {text(
              'Сохранённое назначение ожидает ответа сервера.',
              'Сақталған тағайындау сервер жауабын күтуде.',
            )}{' '}
            {tournament.categories.find((item) => item.id === pending.categoryId)?.name ??
              pending.categoryId}{' '}
            ·{' '}
            {draw?.contests.find((item) => item.id === pending.contestId)?.key ?? pending.contestId}{' '}
            · {text('Татами', 'Татами')}{' '}
            {tournament.tatamis?.find((item) => item.id === pending.payload.tatamiId)?.number ??
              '—'}
          </p>
          <button
            disabled={busy || !pendingRestored || storageError}
            onClick={() => void executeAssignment(pending)}
          >
            {text('Повторить сохранённое назначение', 'Сақталған тағайындауды қайталау')}
          </button>
        </section>
      )}
      {pendingDraw && (
        <section className="panel" role="status">
          <p>
            {text(
              'Команда жеребьёвки ожидает ответа сервера.',
              'Жеребе командасы сервер жауабын күтуде.',
            )}{' '}
            {tournament.categories.find((item) => item.id === pendingDraw.categoryId)?.name ??
              pendingDraw.categoryId}
          </p>
          <button
            disabled={busy || !pendingRestored || storageError || administrationBlocked}
            onClick={() => void executeDraw(pendingDraw)}
          >
            {text('Проверить сохранённую команду', 'Сақталған команданы тексеру')}
          </button>{' '}
          <button onClick={() => exportDraw(pendingDraw)}>
            {text('Скачать команду', 'Команданы жүктеу')}
          </button>
        </section>
      )}
      <div className="draw-workspace-layout">
        <nav
          className="draw-categories"
          aria-label={text('Категории жеребьёвки', 'Жеребе санаттары')}
        >
          <h3>
            {text('Категории', 'Санаттар')} <span>{tournament.categories.length}</span>
          </h3>
          {!tournament.categories.length && (
            <p>{text('Добавьте категории и участников.', 'Санаттар мен қатысушыларды қосыңыз.')}</p>
          )}
          {tournament.categories.map((c) => (
            <button
              key={c.id}
              disabled={blocked}
              aria-current={categoryId === c.id ? 'page' : undefined}
              className={categoryId === c.id ? 'selected' : ''}
              onClick={() => setCategoryId(c.id)}
            >
              <strong>{c.name}</strong>
              <small>
                {c.entries?.length ?? 0} {text('участников', 'қатысушы')} ·{' '}
                {c.draw?.publishedAt
                  ? text('Опубликована', 'Жарияланған')
                  : c.draw?.status === 'CONFIRMED'
                    ? text('Подтверждена', 'Расталған')
                    : c.draw?.status === 'STALE'
                      ? text('Состав изменён', 'Құрам өзгерген')
                      : text('Подготовка', 'Дайындық')}
              </small>
            </button>
          ))}
        </nav>
        <div className="draw-category-workspace">
          {category && (
            <header className="draw-category-heading">
              <div>
                <h3>{category.name}</h3>
                <p>
                  {formatLabel(draw ? drawFormat(draw.snapshot) : category.format, locale)} ·{' '}
                  {category.entries?.length ?? 0} {text('участников', 'қатысушы')}
                </p>
              </div>
              {tournament.rulesSnapshot?.drawPolicy === 'KNOCKOUT_FROM_SIX' && (
                <p className="field-note">
                  {text(
                    '2–5 — круговая · 6–7 — сетка с двумя бронзами · с 8 — выбранная система',
                    '2–5 — айналмалы · 6–7 — екі қоласы бар тор · 8-ден — таңдалған жүйе',
                  )}
                </p>
              )}
              {tournament.rulesSnapshot?.drawPolicy === 'REPECHAGE_ONLY' && (
                <p className="field-note">
                  {text(
                    '2–7 участников — круговая. От 8 — выбранная система; в сетках на выбывание две бронзы через утешение.',
                    '2–7 қатысушы — айналмалы жүйе. 8-ден бастап — таңдалған жүйе; шығару торларында жұбаныш арқылы екі қола медаль.',
                  )}
                </p>
              )}
              <span className="draw-mat-label">
                {mat
                  ? `Татами ${mat.number}`
                  : text('Татами ещё не назначено', 'Татами әлі тағайындалмаған')}
              </span>
            </header>
          )}
          {error && (
            <p role="alert" className="error-box">
              {error}
            </p>
          )}
          {loadError && (
            <p role="alert" className="error-box">
              {loadError}{' '}
              <button disabled={busy} onClick={() => setRefresh((value) => value + 1)}>
                {text('Обновить сетку', 'Торды жаңарту')}
              </button>
            </p>
          )}
          {loading ? (
            <p role="status">{text('Загрузка…', 'Жүктелуде…')}</p>
          ) : (
            category && (
              <>
                {activeEntryCount(category) < 2 && (
                  <p className="info-note" role="status">
                    {activeEntryCount(category) === 0
                      ? text(
                          'Категория без участников будет пропущена при запуске. Её настройки сохранены для ввода заявок.',
                          'Қатысушысыз санат басталған кезде өткізілмейді. Өтінім енгізу үшін баптаулары сақталады.',
                        )
                      : text(
                          'Для сетки нужен соперник. В категории один участник; добавьте второго или исправьте заявку до запуска.',
                          'Тор үшін қарсылас қажет. Санатта бір қатысушы бар; екіншісін қосыңыз немесе басталғанға дейін өтінімді түзетіңіз.',
                        )}
                  </p>
                )}
                {draw?.status === 'STALE' && (
                  <p className="info-note" role="status">
                    {text(
                      'Состав изменился. Повторите жеребьёвку и проверьте новые пары перед подтверждением. Предыдущая версия сохранена в истории.',
                      'Құрам өзгерді. Растамас бұрын жеребені қайталап, жаңа жұптарды тексеріңіз. Алдыңғы нұсқа тарихта сақталған.',
                    )}
                  </p>
                )}
                <div className="draw-actions-grid">
                  <section>
                    <span className="draw-step">01</span>
                    <h4>{text('Создать сетку', 'Тор құру')}</h4>
                    <p>
                      {draw?.status === 'STALE'
                        ? text('Требуется повторная жеребьёвка', 'Жеребені қайталау қажет')
                        : draw
                          ? text('Пары сформированы', 'Жұптар құрылды')
                          : text('Из состава категории', 'Санат қатысушыларынан')}
                    </p>
                    {draw?.status === 'CONFIRMED' ? (
                      <span className="draw-action-done">✓ {text('Готово', 'Дайын')}</span>
                    ) : (
                      <button
                        disabled={blocked || activeEntryCount(category) < 2}
                        onClick={() => action('preview')}
                      >
                        {draw
                          ? text('Повторить жеребьёвку', 'Жеребені қайталау')
                          : text('Создать сетку', 'Тор құру')}
                      </button>
                    )}
                  </section>
                  <section>
                    <span className="draw-step">02</span>
                    <h4>{text('Подтвердить', 'Растау')}</h4>
                    <p>
                      {text(
                        'Проверить пары и закрепить состав',
                        'Жұптарды тексеріп, құрамды бекіту',
                      )}
                    </p>
                    {draw?.status === 'CONFIRMED' ? (
                      <span className="draw-action-done">✓ {text('Подтверждено', 'Расталды')}</span>
                    ) : (
                      <button
                        className="solid-button"
                        disabled={blocked || !draw || draw.status === 'STALE'}
                        onClick={() => action('confirm')}
                      >
                        {text('Подтвердить сетку', 'Торды растау')}
                      </button>
                    )}
                  </section>
                  <section>
                    <span className="draw-step">03</span>
                    <h4>{text('Публикация', 'Жариялау')}</h4>
                    <p>
                      {draw?.publishedAt
                        ? text('Сетка доступна зрителям', 'Тор көрермендерге ашық')
                        : text('Сетка скрыта от зрителей', 'Тор көрермендерден жасырылған')}
                    </p>
                    <button
                      disabled={blocked || draw?.status !== 'CONFIRMED'}
                      onClick={() => void action('publication')}
                    >
                      {draw?.publishedAt
                        ? text('Скрыть сетку', 'Торды жасыру')
                        : text('Опубликовать сетку', 'Торды жариялау')}
                    </button>
                    {draw?.publishedAt && !tournament.publishedAt && (
                      <small>
                        {text('Также опубликуйте сам турнир.', 'Турнирдің өзін де жариялаңыз.')}
                      </small>
                    )}
                  </section>
                </div>
                {draw && draw.status !== 'STALE' && (
                  <>
                    <div className="draw-canvas-panel">
                      <DrawView
                        key={draw.id + ':' + draw.version}
                        draw={draw.snapshot}
                        entries={category.entries ?? []}
                        contests={draw.contests}
                        tatamis={tournament.tatamis ?? []}
                        busy={blocked}
                        canAssign={!!tatamiId && draw.status === 'CONFIRMED'}
                        onAssign={(id) => void assign(id)}
                      />
                    </div>
                    <details className="draw-bottom-section">
                      <summary>
                        {text('Участники категории', 'Санат қатысушылары')} ·{' '}
                        {category.entries?.length ?? 0}
                      </summary>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>№</th>
                              <th>{text('Участник', 'Қатысушы')}</th>
                              <th>{text('Клуб', 'Клуб')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {category.entries?.map((e, i) => (
                              <tr key={e.id}>
                                <td>{i + 1}</td>
                                <td>
                                  {e.lastName} {e.firstName}
                                </td>
                                <td>{e.club}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                    <details className="draw-bottom-section">
                      <summary>{text('Подтверждённые результаты', 'Расталған нәтижелер')}</summary>
                      <ResultsTable entries={category.entries ?? []} contests={draw.contests} />
                      {!draw.contests.some((c) => c.status === 'CONFIRMED') && (
                        <p>
                          {text(
                            'Пока нет подтверждённых результатов.',
                            'Әзірге расталған нәтижелер жоқ.',
                          )}
                        </p>
                      )}
                    </details>
                    <details className="draw-bottom-section">
                      <summary>{text('Параметры жеребьёвки', 'Жеребе параметрлері')}</summary>
                      <p>
                        {text(
                          'Пользовательский регламент. Соответствие IJF не проверено.',
                          'Бапталатын ереже. IJF сәйкестігі тексерілмеген.',
                        )}
                      </p>
                      <p>
                        BYE: {draw.snapshot.positions.filter((p) => p === null).length} ·{' '}
                        {text(
                          'Одноклубных пар в первом круге',
                          'Бірінші айналымдағы клубтас жұптар',
                        )}
                        : {draw.snapshot.firstRoundClubPairs}
                      </p>
                    </details>
                  </>
                )}
              </>
            )
          )}
        </div>
      </div>
      <TiebreakReview
        tournamentId={tournament.id}
        categoryId={categoryId}
        entries={tournament.categories.flatMap((category) => category.entries ?? [])}
        disabled={externalBlocked || withdrawalPending}
        onPendingChange={setTiePending}
        onSelectCategory={setCategoryId}
        onUpdated={() => {
          setRefresh((v) => v + 1);
          void onUpdate();
        }}
      />
      <WithdrawEntry
        tournamentId={tournament.id}
        categoryId={categoryId}
        entries={category?.entries ?? []}
        withdrawnIds={draw?.snapshot.withdrawnEntryIds ?? []}
        available={
          draw?.status === 'CONFIRMED' &&
          draw.snapshot.tieRanking === 'WINS_ONLY' &&
          tournament.status !== 'FINISHED'
        }
        disabled={externalBlocked || tiePending}
        onPendingChange={setWithdrawalPending}
        onSelectCategory={setCategoryId}
        onUpdated={() => {
          setRefresh((v) => v + 1);
          void onUpdate();
        }}
      />
      <Link
        className="back-link"
        href={`/tournaments/${tournament.id}/control`}
        aria-disabled={blocked}
        onClick={(event) => {
          if (blocked) event.preventDefault();
        }}
      >
        {text('Перейти в центр татами', 'Татами орталығына өту')} →
      </Link>
    </section>
  );
}
