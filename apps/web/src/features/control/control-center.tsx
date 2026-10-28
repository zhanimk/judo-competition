'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { scoreboardScores, type MatchState } from '@judo/engine/match';
import { request } from '../tournaments/api';
import { useLanguage } from '../../shared/i18n/provider';
import { subscribeTournament } from '../../shared/live/subscribe';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import './control.css';
import { ControlQueue, type QueueBout } from './control-queue';
import { useAdminCommand } from './use-admin-command';
import { PendingControlReview } from './pending-review';
import { ClockCorrectionReview } from './clock-review';
import { clockEditValue, previewClockCorrection } from './clock-edit';
import type { AdminAction, AdminCommandPayload } from './pending-command';
type Person = { firstName: string; lastName: string };
type Row = {
  id: string;
  key: string;
  category: string;
  status: string;
  revision: number;
  offlineActive?: boolean;
  tatamiId: string | null;
  white?: Person;
  blue?: Person;
  queueOrder: number | null;
};
type Mat = {
  id: string;
  number: number;
  remaining: number;
  finished: number;
  scheduledSeconds: number;
  queue: QueueBout[];
  live: {
    currentMatch: null | {
      id: string;
      key: string;
      category: string;
      revision: number;
      state: MatchState;
      white: Person;
      blue: Person;
    };
  };
};
type Dashboard = {
  id: string;
  name: string;
  status: string;
  total: number;
  finished: number;
  unassigned: number;
  tatamis: Mat[];
  contests: Row[];
};
type Action = AdminAction;
type Impact = {
  revision: number;
  impactToken: string;
  blocked: boolean;
  dependent: { id: string; key: string; status: string }[];
  stoppedClock: {
    phase: 'REGULAR' | 'GOLDEN';
    elapsedMs: number;
    durationMs: number;
    status: string;
    hasHold: boolean;
  } | null;
  clockState: MatchState | null;
};
const clock = (ms: number) =>
  `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, '0')}`;
const name = (p?: Person | null) => (p ? `${p.lastName} ${p.firstName}` : '—');
export function ControlCenter({ tournamentId }: { tournamentId: string }) {
  const { text } = useLanguage();
  const admin = useAdminCommand(tournamentId);
  const [data, setData] = useState<Dashboard | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [projection, setProjection] = useState(0);
  const [filter, setFilter] = useState('OPEN'),
    [matFilter, setMatFilter] = useState('ALL'),
    [search, setSearch] = useState('');
  const [review, setReview] = useState<{ row: Row; type: Action; impact: Impact } | null>(null),
    [reason, setReason] = useState(''),
    [target, setTarget] = useState(''),
    [timeValue, setTimeValue] = useState('');
  const received = useRef(0),
    poller = useRef<ReturnType<typeof pollSnapshots<Dashboard>> | null>(null),
    reviewElement = useRef<HTMLElement>(null),
    allMatchesElement = useRef<HTMLElement>(null),
    preparing = useRef<symbol | null>(null),
    currentTournament = useRef(tournamentId);
  currentTournament.current = tournamentId;
  const commandsBlocked = busy || !connected || admin.blocked;
  const refresh = useCallback(async () => {
    await poller.current?.refresh();
  }, []);
  useEffect(() => {
    setData(null);
    setConnected(false);
    setReview(null);
    setError('');
    setBusy(false);
    preparing.current = null;
    const currentPoller = pollSnapshots(
      () => request<Dashboard>(`/tournaments/${tournamentId}/control`),
      (d) => {
        setData(d);
        setConnected(true);
        received.current = performance.now();
        setProjection(0);
      },
      () => setConnected(false),
      2000,
    );
    poller.current = currentPoller;
    void refresh();
    const clockTimer = setInterval(
      () => setProjection(Math.min(2500, performance.now() - received.current)),
      100,
    );
    const unsubscribe = subscribeTournament(tournamentId, (e) => {
      if (e.kind !== 'state') void refresh();
    });
    return () => {
      currentPoller.stop();
      if (poller.current === currentPoller) poller.current = null;
      clearInterval(clockTimer);
      unsubscribe();
    };
  }, [tournamentId, refresh]);
  const status = (s: string) =>
    ({
      READY: text('Готова', 'Дайын'),
      WAITING: text('Ожидает участников', 'Қатысушыларды күтуде'),
      ACTIVE: text('На табло', 'Таблода'),
      CONFIRMED: text('Результат подтверждён', 'Нәтиже расталған'),
    })[s] ?? s;
  const actionLabel = (a: Action) =>
    ({
      RELEASE_OFFLINE: text('Отозвать автономное управление', 'Автономды басқаруды қайтару'),
      MOVE: text('Перенести / поставить в очередь', 'Ауыстыру / кезекке қою'),
      RESET: text('Отменить схватку и поставить заново', 'Белдесуді тоқтатып, қайта қою'),
      REOPEN: text('Отменить подтверждение победы', 'Жеңісті растауды қайтару'),
      REMOVE: text('Снять с очереди', 'Кезектен алу'),
      EDIT_TIME: text('Исправить время', 'Уақытты түзету'),
    })[a];
  function message(e: unknown) {
    const code = (e as Error).message;
    const messages: Record<string, string> = {
      OFFLINE_OWNED: text(
        'Схваткой управляет автономное табло. Сначала синхронизируйте его или явно отзовите управление.',
        'Белдесуді автономды табло басқарады. Алдымен синхрондаңыз немесе басқаруды қайтарыңыз.',
      ),
      TIEBREAK_REVIEW_REQUIRED: text(
        'Назначены дополнительные встречи. Администратор должен отдельно проверить последствия исправления.',
        'Қосымша белдесулер тағайындалған. Әкімші түзетудің салдарын бөлек тексеруі керек.',
      ),
      DEPENDENT_CONTESTS_STARTED: text(
        'Зависимая схватка уже началась или завершена. Её нужно разобрать первой; автоматическая отмена запрещена.',
        'Тәуелді белдесу басталған немесе аяқталған. Алдымен оны қарау керек; автоматты қайтаруға тыйым салынған.',
      ),
      VERSION_CONFLICT: text(
        'Данные изменились. Заново выберите действие.',
        'Деректер өзгерді. Әрекетті қайта таңдаңыз.',
      ),
      IMPACT_CHANGED: text(
        'Зависимые встречи изменились. Заново откройте проверку последствий.',
        'Тәуелді белдесулер өзгерді. Салдарын қайта тексеріңіз.',
      ),
      MATCH_NOT_MOVABLE: text(
        'Эту схватку уже нельзя перенести. Обновите список.',
        'Бұл белдесуді ауыстыру мүмкін емес. Тізімді жаңартыңыз.',
      ),
      TATAMI_BUSY: text('Выбранное татами занято.', 'Таңдалған татами бос емес.'),
      TATAMI_OR_ATHLETE_BUSY: text(
        'Татами или участник занят другой схваткой.',
        'Татами немесе қатысушы басқа белдесуге қатысуда.',
      ),
      REST_REQUIRED: text(
        'Спортсмен ещё не завершил обязательный отдых после другой схватки. Повторите действие после отдыха.',
        'Спортшы басқа белдесуден кейінгі міндетті демалысын аяқтамаған. Демалыстан кейін әрекетті қайталаңыз.',
      ),
      MATCH_NOT_READY: text(
        'Участники схватки недоступны или их привязки несогласованы. Обновите очередь; администратор должен проверить состав.',
        'Белдесу қатысушылары қолжетімсіз немесе олардың байланыстары сәйкес емес. Кезекті жаңартыңыз; әкімші құрамды тексеруі керек.',
      ),
      PAUSE_REQUIRED: text(
        'Перед изменением остановите время в пульте.',
        'Өзгерту алдында пультте уақытты тоқтатыңыз.',
      ),
      RESET_FIRST: text(
        'Сначала отмените текущую схватку с повторной постановкой.',
        'Алдымен ағымдағы белдесуді тоқтатып, қайта қойыңыз.',
      ),
      REOPEN_FIRST: text(
        'Сначала отмените подтверждение результата.',
        'Алдымен нәтижені растауды қайтарыңыз.',
      ),
      RESOLVE_HOLD_FIRST: text(
        'Сначала завершите удержание в пульте.',
        'Алдымен пультте ұстап тұруды аяқтаңыз.',
      ),
      RESULT_LOCKED: text(
        'У встречи уже есть результат. Сначала проверьте его в пульте.',
        'Белдесудің нәтижесі бар. Алдымен оны пультте тексеріңіз.',
      ),
      CLOCK_PHASE_MISMATCH: text(
        'Фаза встречи изменилась. Заново откройте проверку времени.',
        'Белдесу кезеңі өзгерген. Уақытты тексеруді қайта ашыңыз.',
      ),
      INVALID_TIME: text(
        'Время выходит за допустимый диапазон.',
        'Уақыт рұқсат етілген аралықтан тыс.',
      ),
      ADMIN_PENDING_CORRUPT: text(
        'Сохранённая команда требует ручной проверки.',
        'Сақталған команданы қолмен тексеру қажет.',
      ),
      ADMIN_PENDING_EXISTS: text(
        'Сначала разберите исход незавершённой команды.',
        'Алдымен аяқталмаған команданың нәтижесін тексеріңіз.',
      ),
      ADMIN_RECEIPT_INVALID: text(
        'Ответ сервера не подтверждает исход команды. Исходная запись сохранена для точного повтора.',
        'Сервер жауабы команданың нәтижесін растамайды. Бастапқы жазба дәл қайталау үшін сақталған.',
      ),
    };
    return messages[code] ?? text('Действие не выполнено: ', 'Әрекет орындалмады: ') + code;
  }
  async function prepare(row: Row, type: Action) {
    if (commandsBlocked || admin.hasPending() || preparing.current) return;
    const attempt = Symbol('control-impact');
    preparing.current = attempt;
    setBusy(true);
    setError('');
    setReview(null);
    setReason('');
    setNotice('');
    setTarget('');
    setTimeValue('');
    try {
      const impact = await request<Impact>(`/tournaments/${tournamentId}/control/${row.id}/impact`);
      if (currentTournament.current !== tournamentId || preparing.current !== attempt) return;
      setReview({ row, type, impact });
      if (type === 'EDIT_TIME' && impact.clockState)
        setTimeValue(clockEditValue(impact.clockState));
    } catch (e) {
      if (currentTournament.current === tournamentId) setError(message(e));
    } finally {
      if (preparing.current === attempt) {
        preparing.current = null;
        if (currentTournament.current === tournamentId) setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (review) reviewElement.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [review]);
  async function confirm() {
    if (!review || commandsBlocked || admin.hasPending()) return;
    setError('');
    try {
      const base = {
        id: crypto.randomUUID(),
        expectedRevision: review.impact.revision,
        impactToken: review.impact.impactToken,
        reason: reason.trim(),
      };
      let payload: AdminCommandPayload;
      if (review.type === 'MOVE') payload = { ...base, type: 'MOVE', tatamiId: target };
      else if (review.type === 'EDIT_TIME') {
        if (!review.impact.clockState) return;
        payload = {
          ...base,
          type: 'EDIT_TIME',
          ...previewClockCorrection(review.impact.clockState, timeValue).correction,
        };
      } else payload = { ...base, type: review.type };
      const result = await admin.execute({
        tournamentId,
        contestId: review.row.id,
        payload,
        review: {
          key: review.row.key,
          category: review.row.category,
          white: name(review.row.white),
          blue: name(review.row.blue),
          dependent: review.impact.dependent,
          ...(review.type === 'MOVE'
            ? { targetNumber: data?.tatamis.find((m) => m.id === target)?.number }
            : {}),
        },
      });
      if (currentTournament.current !== tournamentId) return;
      if (result?.kind === 'success') setNotice(text('Изменение сохранено.', 'Өзгеріс сақталды.'));
      setReview(null);
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  }
  async function retry() {
    if (!connected || busy) return;
    const result = await admin.execute();
    if (result?.kind === 'success')
      setNotice(text('Исходная команда подтверждена.', 'Бастапқы команда расталды.'));
    await refresh();
  }
  const pendingRow = data?.contests.find((row) => row.id === admin.pending?.contestId);
  const pendingLive = data?.tatamis.find((mat) => mat.live.currentMatch?.id === pendingRow?.id)
    ?.live.currentMatch;
  const currentEvidence = pendingRow
    ? [
        `${pendingRow.category} · ${pendingRow.key} · ${status(pendingRow.status)} · ${text('версия', 'нұсқа')} ${pendingRow.revision}`,
        pendingLive
          ? `${pendingLive.state.status} · ${pendingLive.state.phase} ${clockEditValue(pendingLive.state)}${pendingLive.state.outcome ? ` · ${text('Победитель', 'Жеңімпаз')}: ${name(pendingLive.state.outcome.winner === 'WHITE' ? pendingLive.white : pendingLive.blue)}` : ''}`
          : '',
        admin.pending?.review.dependent?.length
          ? text('Зависимые встречи', 'Тәуелді белдесулер') +
            ': ' +
            admin.pending.review.dependent
              .map(
                (row) =>
                  `${row.key} (${status(data?.contests.find((current) => current.id === row.id)?.status ?? row.status)})`,
              )
              .join(', ')
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : text(
        'Встреча не найдена в актуальном списке. Проверьте сетку и протокол.',
        'Белдесу өзекті тізімде табылмады. Тор мен хаттаманы тексеріңіз.',
      );
  const pendingPanel = (
    <PendingControlReview
      key={admin.pending?.payload.id ?? tournamentId}
      tournamentId={tournamentId}
      pending={admin.pending}
      corrupt={admin.corrupt}
      connected={connected}
      busy={busy || admin.sending}
      current={currentEvidence}
      reviewVersion={JSON.stringify([
        pendingRow?.revision,
        pendingLive?.state.status,
        data?.contests
          .filter((row) =>
            admin.pending?.review.dependent?.some((dependent) => dependent.id === row.id),
          )
          .map((row) => [row.id, row.revision, row.status]),
      ])}
      actionLabel={actionLabel}
      onRetry={() => void retry()}
      onRefresh={() => void refresh()}
      onArchive={(why, checked) => {
        admin.archive(why, checked);
        setReview(null);
      }}
    />
  );
  if (!data)
    return (
      <div className="control-center">
        {admin.problem ? (
          <p className="error-box" role="alert">
            {message(admin.problem)}
          </p>
        ) : null}
        {pendingPanel}
        <section className="panel state-box">
          {text('Загружаем центральное управление…', 'Орталық басқару жүктелуде…')}{' '}
          {!connected && <button onClick={refresh}>{text('Повторить', 'Қайталау')}</button>}
        </section>
      </div>
    );
  const rows = data.contests.filter(
    (c) =>
      (filter === 'ALL' ||
        (filter === 'FINISHED' ? c.status === 'CONFIRMED' : c.status !== 'CONFIRMED')) &&
      (matFilter === 'ALL' || (matFilter === 'NONE' ? !c.tatamiId : c.tatamiId === matFilter)) &&
      `${c.key} ${c.category} ${name(c.white)} ${name(c.blue)}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  const selectedMat = data.tatamis.find((m) => m.id === target);
  const movingLive =
    review?.row.status === 'ACTIVE'
      ? data.tatamis.find((m) => m.live.currentMatch?.id === review.row.id)?.live.currentMatch
      : null;
  const moveBlocked =
    review?.type === 'MOVE' &&
    (!selectedMat ||
      target === review.row.tatamiId ||
      movingLive?.state.status === 'RUNNING' ||
      !!movingLive?.state.hold ||
      (review.row.status === 'ACTIVE' && !!selectedMat.live.currentMatch));
  let timeBlocked = review?.type === 'EDIT_TIME';
  if (review?.type === 'EDIT_TIME' && review.impact.clockState) {
    try {
      previewClockCorrection(review.impact.clockState, timeValue);
      timeBlocked = false;
    } catch {
      /* The review explains the blocked clock input. */
    }
  }
  function showQueue(matId: string) {
    setMatFilter(matId);
    setFilter('ALL');
    setSearch('');
    allMatchesElement.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return (
    <div className="control-center">
      <div className="panel-heading">
        <div>
          <p className="kicker">{data.name}</p>
          <h2>{text('Татами', 'Татами')}</h2>
        </div>
        <Link className="outline-link" href={`/tournaments/${tournamentId}`}>
          ← {text('Турнир', 'Турнир')}
        </Link>
      </div>
      {!connected && (
        <p className="error-box" role="alert">
          {text(
            'Связь потеряна. Команды заблокированы до обновления.',
            'Байланыс үзілді. Жаңартылғанша командалар бұғатталған.',
          )}
        </p>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {admin.problem ? (
        <p className="error-box" role="alert">
          {message(admin.problem)}
        </p>
      ) : null}
      {pendingPanel}
      {notice && (
        <p className="control-notice" role="status">
          {notice}
        </p>
      )}
      <div className="control-summary">
        <span>
          {text('Всего', 'Барлығы')}: <b>{data.total}</b>
        </span>
        <span>
          {text('Завершено', 'Аяқталған')}: <b>{data.finished}</b>
        </span>
        <span>
          {text('Осталось', 'Қалғаны')}: <b>{data.total - data.finished}</b>
        </span>
        <span>
          {text('Готовы без татами', 'Татамисіз дайын')}: <b>{data.unassigned}</b>
        </span>
      </div>
      <div className="control-mats">
        {data.tatamis.map((mat) => {
          const m = mat.live.currentMatch,
            s = m?.state,
            delta = s?.status === 'RUNNING' ? projection : 0;
          const remaining = s ? Math.max(0, s.rules.durationMs - s.elapsedMs - delta) : 0;
          return (
            <article className={`panel control-mat ${m ? 'is-active' : ''}`} key={mat.id}>
              <div className="control-mat-header">
                <h3>Татами {mat.number}</h3>
                <span className="draft">
                  {s?.status === 'RUNNING'
                    ? text('Время идёт', 'Уақыт жүріп жатыр')
                    : s?.status === 'PROVISIONAL'
                      ? text('Подтвердить результат', 'Нәтижені растау')
                      : m
                        ? text('Пауза / решение', 'Үзіліс / шешім')
                        : text('Свободно', 'Бос')}
                </span>
              </div>
              {m && s ? (
                <>
                  <p>
                    {m.category} · {m.key}
                  </p>
                  <div className="control-clock">
                    <strong>
                      {s.phase === 'GOLDEN' ? clock(s.goldenMs + delta) : clock(remaining)}
                    </strong>
                    <span>
                      {s.phase === 'GOLDEN' ? 'GOLDEN SCORE' : text('Осталось', 'Қалған уақыт')}
                    </span>
                  </div>
                  <p className="field-note">
                    {text('Прошло', 'Өткен уақыт')}:{' '}
                    {clock(
                      Math.min(
                        s.rules.durationMs,
                        s.elapsedMs + (s.phase === 'REGULAR' ? delta : 0),
                      ),
                    )}
                    {s.hold ? ` · OSAEKOMI ${clock(s.hold.elapsedMs + delta)}` : ''}
                  </p>
                  {(['WHITE', 'BLUE'] as const).map((side) => {
                    const score = scoreboardScores(s, side);
                    return (
                      <div
                        className={`control-athlete ${side === 'BLUE' ? 'blue' : ''}`}
                        key={side}
                      >
                        <strong>{name(side === 'WHITE' ? m.white : m.blue)}</strong>
                        <div>
                          {(['IPPON', 'WAZA_ARI', 'YUKO', 'SHIDO'] as const).map((k) => (
                            <span key={k}>
                              {k.replace('_', '-')} <b>{score[k]}</b>
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  <Link className="solid-link" href={`/operator/${mat.id}`}>
                    {text('Открыть пульт для управления', 'Басқару үшін пультті ашу')} →
                  </Link>
                </>
              ) : (
                <div className="control-empty">
                  {text('Ожидает следующую схватку', 'Келесі белдесуді күтуде')}
                </div>
              )}
              <div className="control-counts">
                <span>
                  {text('В очереди / на табло', 'Кезекте / таблода')}: <b>{mat.remaining}</b>
                </span>
                <span>
                  {text('Завершено', 'Аяқталған')}: <b>{mat.finished}</b>
                </span>
                <span>
                  {text('Время готовой очереди', 'Дайын кезек уақыты')}: ≈{' '}
                  {Math.ceil(mat.scheduledSeconds / 60)} {text('мин', 'мин')}
                </span>
              </div>
              {m && (
                <button
                  disabled={commandsBlocked}
                  onClick={() => {
                    const row = data.contests.find((c) => c.id === m.id);
                    if (row) void prepare(row, 'MOVE');
                  }}
                >
                  {text('Перенести текущую схватку', 'Ағымдағы белдесуді ауыстыру')}
                </button>
              )}
              <ControlQueue
                queue={mat.queue}
                disabled={commandsBlocked}
                onMove={(id) => {
                  const row = data.contests.find((c) => c.id === id);
                  if (row) void prepare(row, 'MOVE');
                }}
                onShowAll={() => showQueue(mat.id)}
              />
              <div className="form-actions">
                <Link className="solid-link" href={`/operator/${mat.id}`}>
                  {text('Пульт', 'Пульт')} →
                </Link>
                <Link
                  className="outline-link"
                  href={`/tournaments/${tournamentId}/tatamis/${mat.id}/display`}
                >
                  {text('Экран', 'Экран')} ↗
                </Link>
                <Link href={`/tournaments/${tournamentId}/tatamis/${mat.id}`}>
                  {text('Ссылки и доступ', 'Сілтемелер және рұқсат')}
                </Link>
              </div>
            </article>
          );
        })}
      </div>
      <details className="interface-help">
        <summary>{text('Как рассчитана очередь', 'Кезек қалай есептеледі')}</summary>
        <p className="field-note">
          {text(
            'Время очереди — сумма основного времени готовых схваток, без пауз, отдыха и Golden Score. Неразрешённые встречи учтены в общем числе оставшихся.',
            'Кезек уақыты — дайын белдесулердің негізгі уақытының қосындысы; үзіліс, демалыс және Golden Score кірмейді. Қатысушылары анықталмаған белдесулер жалпы қалған санға кіреді.',
          )}
        </p>
      </details>
      {review && (
        <section
          className="panel form-panel control-review"
          ref={reviewElement}
          aria-label={text('Проверка изменения', 'Өзгерісті тексеру')}
        >
          <h3>{actionLabel(review.type)}</h3>
          <p>
            {review.row.category} · {review.row.key} · {name(review.row.white)} /{' '}
            {name(review.row.blue)}
          </p>
          {review.type === 'REOPEN' ? (
            <>
              <p>
                {text(
                  'Подтверждённая победа будет отозвана из сетки и протокола. Счёт сохранится в пульте для исправления. Начатые зависимые встречи отменять автоматически нельзя.',
                  'Расталған жеңіс тор мен хаттамадан қайтарылады. Есеп түзету үшін пультте сақталады. Басталған тәуелді белдесулер автоматты тоқтатылмайды.',
                )}
              </p>
              <p>
                {text('Зависимые встречи', 'Тәуелді белдесулер')}:{' '}
                {review.impact.dependent.length
                  ? review.impact.dependent.map((c) => `${c.key} (${status(c.status)})`).join(', ')
                  : text('нет', 'жоқ')}
              </p>
              {review.impact.blocked && (
                <p className="error-box">
                  {text(
                    'Отмена заблокирована: зависимая встреча началась или завершена.',
                    'Қайтару бұғатталған: тәуелді белдесу басталған немесе аяқталған.',
                  )}
                </p>
              )}
            </>
          ) : review.type === 'EDIT_TIME' ? (
            <ClockCorrectionReview
              state={review.impact.clockState}
              value={timeValue}
              white={name(review.row.white)}
              blue={name(review.row.blue)}
              disabled={commandsBlocked}
              onChange={setTimeValue}
            />
          ) : (
            <p>
              {review.type === 'RELEASE_OFFLINE'
                ? text(
                    'Управление устройства будет отозвано. Несинхронизированные действия не будут приняты автоматически. Сохранённое на сервере время остановится; сверьте журнал устройства перед продолжением.',
                    'Құрылғының басқаруы қайтарылады. Синхрондалмаған әрекеттер автоматты қабылданбайды. Серверде сақталған уақыт тоқтайды; жалғастырмас бұрын құрылғы журналын салыстырыңыз.',
                  )
                : review.type === 'RESET'
                  ? text(
                      'Текущее время и оценки будут сброшены. Встреча вернётся в очередь своего круга с учётом возраста и веса. История останется в журнале.',
                      'Ағымдағы уақыт пен бағалар қалпына келтіріледі. Белдесу жас пен салмақ ескеріліп, өз айналымының кезегіне оралады. Тарих журналда сақталады.',
                    )
                  : review.type === 'REMOVE'
                    ? text(
                        'Схватка сохранится и останется готовой без назначения татами.',
                        'Белдесу сақталып, татамиге тағайындалмай дайын күйде қалады.',
                      )
                    : text(
                        'Встреча попадёт в очередь выбранного татами с учётом круга, возраста и веса. Закрепление категории не меняется. Для переноса активной схватки остановите её таймер.',
                        'Белдесу айналым, жас пен салмақ ескеріліп, таңдалған татамидің кезегіне түседі. Санаттың бекітілген татамиі өзгермейді. Белсенді белдесуді ауыстыру үшін таймерін тоқтатыңыз.',
                      )}
            </p>
          )}
          {review.type === 'MOVE' && (
            <fieldset className="control-destinations" disabled={commandsBlocked}>
              <legend>{text('Куда перенести схватку', 'Белдесуді қайда ауыстыру керек')}</legend>
              <p>
                {text('Сейчас', 'Қазір')}:{' '}
                {review.row.tatamiId
                  ? `Татами ${data.tatamis.find((m) => m.id === review.row.tatamiId)?.number}`
                  : text('Без татами', 'Татамисіз')}
              </p>
              <div className="control-targets">
                {data.tatamis.map((mat) => {
                  const current = mat.id === review.row.tatamiId;
                  const occupied = !!mat.live.currentMatch;
                  return (
                    <label key={mat.id} className={target === mat.id ? 'is-selected' : ''}>
                      <input
                        type="radio"
                        name="move-tatami"
                        value={mat.id}
                        checked={target === mat.id}
                        disabled={current || (review.row.status === 'ACTIVE' && occupied)}
                        onChange={() => setTarget(mat.id)}
                      />
                      <strong>Татами {mat.number}</strong>
                      <span>
                        {current
                          ? text('Текущее татами', 'Ағымдағы татами')
                          : occupied
                            ? text('Идёт схватка', 'Белдесу жүріп жатыр')
                            : text('Сейчас свободно', 'Қазір бос')}
                      </span>
                      <span>
                        {text('Готовых пар', 'Дайын жұптар')}: {mat.queue.length} · ≈{' '}
                        {Math.ceil(mat.scheduledSeconds / 60)} {text('мин', 'мин')}
                      </span>
                    </label>
                  );
                })}
              </div>
              {movingLive?.state.status === 'RUNNING' && (
                <p className="error-box">
                  {text(
                    'Сначала остановите время на текущем татами.',
                    'Алдымен ағымдағы татамиде уақытты тоқтатыңыз.',
                  )}
                </p>
              )}
              {!!movingLive?.state.hold && (
                <p className="error-box">
                  {text(
                    'Сначала завершите удержание в пульте.',
                    'Алдымен пультте ұстап тұруды аяқтаңыз.',
                  )}
                </p>
              )}
              <p className="field-note">
                {review.row.status === 'ACTIVE'
                  ? text(
                      'Счёт и время сохранятся. После переноса продолжайте схватку с нового пульта.',
                      'Есеп пен уақыт сақталады. Ауыстырғаннан кейін жаңа пульттен жалғастырыңыз.',
                    )
                  : text(
                      'Пара появится в очереди нового татами. Перед стартом сервер проверит круг и обязательный отдых.',
                      'Жұп жаңа татамидің кезегіне түседі. Бастау алдында сервер айналым мен міндетті демалысты тексереді.',
                    )}
              </p>
              <button
                type="button"
                onClick={() =>
                  setReason(
                    text(
                      'Выравнивание нагрузки между татами',
                      'Татамилер арасындағы жүктемені теңестіру',
                    ),
                  )
                }
              >
                {text('Причина: выравнивание нагрузки', 'Себеп: жүктемені теңестіру')}
              </button>
            </fieldset>
          )}
          <label>
            {text('Причина для журнала', 'Журналға арналған себеп')}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={3}
              maxLength={300}
              disabled={commandsBlocked}
            />
          </label>
          <div className="form-actions">
            <button
              className="solid-button"
              disabled={
                commandsBlocked ||
                reason.trim().length < 3 ||
                (review.type === 'REOPEN' && review.impact.blocked) ||
                !!moveBlocked ||
                timeBlocked
              }
              onClick={confirm}
            >
              {text('Подтвердить изменение', 'Өзгерісті растау')}
            </button>
            <button disabled={busy || admin.sending} onClick={() => setReview(null)}>
              {text('Назад без изменений', 'Өзгертпей қайту')}
            </button>
          </div>
        </section>
      )}
      <section className="panel" ref={allMatchesElement}>
        <div className="panel-heading">
          <h3>
            {text('Все схватки', 'Барлық белдесулер')} · {rows.length}
          </h3>
        </div>
        <div className="control-filters">
          <input
            aria-label={text('Поиск схватки', 'Белдесуді іздеу')}
            placeholder={text('Участник, категория, номер', 'Қатысушы, санат, нөмір')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label={text('Статус', 'Мәртебе')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="OPEN">{text('Предстоящие и активные', 'Алдағы және белсенді')}</option>
            <option value="FINISHED">{text('Завершённые', 'Аяқталған')}</option>
            <option value="ALL">{text('Все', 'Барлығы')}</option>
          </select>
          <select
            aria-label="Татами"
            value={matFilter}
            onChange={(e) => setMatFilter(e.target.value)}
          >
            <option value="ALL">{text('Все татами', 'Барлық татами')}</option>
            <option value="NONE">{text('Без татами', 'Татамисіз')}</option>
            {data.tatamis.map((m) => (
              <option value={m.id} key={m.id}>
                Татами {m.number}
              </option>
            ))}
          </select>
        </div>
        <div className="table-wrap control-table">
          <table>
            <thead>
              <tr>
                <th>{text('Схватка', 'Белдесу')}</th>
                <th>{text('Участники', 'Қатысушылар')}</th>
                <th>{text('Статус', 'Мәртебе')}</th>
                <th>{text('Управление', 'Басқару')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.category}</strong>
                    <small>
                      {c.key} ·{' '}
                      {c.tatamiId
                        ? `Татами ${data.tatamis.find((m) => m.id === c.tatamiId)?.number}`
                        : '—'}
                    </small>
                  </td>
                  <td>
                    {name(c.white)}
                    <br />
                    {name(c.blue)}
                  </td>
                  <td>{status(c.status)}</td>
                  <td>
                    <div className="control-row-actions">
                      {(c.offlineActive
                        ? (['RELEASE_OFFLINE'] as Action[])
                        : ['READY', 'ACTIVE'].includes(c.status)
                          ? ([
                              'MOVE',
                              'RESET',
                              ...(c.status === 'ACTIVE' ? ['EDIT_TIME'] : []),
                              ...(c.status === 'READY' && c.tatamiId ? ['REMOVE'] : []),
                            ] as Action[])
                          : c.status === 'CONFIRMED'
                            ? (['REOPEN'] as Action[])
                            : []
                      ).map((a) => (
                        <button key={a} disabled={commandsBlocked} onClick={() => prepare(c, a)}>
                          {actionLabel(a)}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <p className="state-box">{text('Нет подходящих схваток', 'Сәйкес белдесулер жоқ')}</p>
          )}
        </div>
      </section>
    </div>
  );
}
