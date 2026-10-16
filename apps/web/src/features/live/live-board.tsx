'use client';
import { useOfflineMatch } from '../offline/use-offline-match';
import { useTabDevice } from '../auth/use-tab-device';
import { useControlLease } from '../auth/use-control-lease';
import { ControlLeasePanel } from '../auth/control-lease-panel';
import { sameGrant, isUuid } from '../auth/control-model';
import { authMessage } from '../auth/messages';
import {
  restoreMatchPending,
  saveMatchPending,
  mayRetryMatch,
  deliverMatchPacket,
  isUnknownMatchFailure,
  reviewedMatchArchive,
  type PendingMatchCommand,
} from './pending-command';
import { PendingMatchReview } from './pending-match-review';
import { resultReasonLabel } from './labels';
import { mergeCommandResponse } from './command-response';
import { refreshParticipantNames } from './participant-names';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchState, Side, Score } from '@judo/engine/match';

import { request, ApiError } from '../tournaments/api';
import { subscribeTournament } from '../../shared/live/subscribe';
import { useLanguage } from '../../shared/i18n/provider';
import { AthleteRow } from '../scoreboard/components/athlete-row';
import type { MatchAction } from '../scoreboard/model/types';
import { time } from '../scoreboard/lib/format-time';
import '../scoreboard/scoreboard.css';
import './live.css';
type Person = { id: string; firstName: string; lastName: string; club: string };
type LiveMatch = {
  id: string;
  key: string;
  category: string;
  revision: number;
  state: MatchState;
  white: Person;
  blue: Person;
  offlineActive?: boolean;
};
export type View = {
  tournamentId: string;
  tournamentName: string;
  tournamentStatus: string;
  number: number;
  currentMatch: LiveMatch | null;
  lastResult: null | { id: string; key: string; resultReason: string; winner?: Person | null };
};

export function LiveBoard({
  tatamiId,
  operator = false,
}: {
  tatamiId: string;
  operator?: boolean;
}) {
  const { text, locale } = useLanguage();
  const device = useTabDevice(operator);
  const lease = useControlLease(tatamiId, device.deviceId, operator);
  const [view, setView] = useState<View | null>(null),
    [connected, setConnected] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<PendingMatchCommand | null>(null),
    [pendingInvalid, setPendingInvalid] = useState(''),
    [queue, setQueue] = useState<
      { id: string; key: string; category: string; revision: number; blockedByRound?: boolean }[]
    >([]),
    [projection, setProjection] = useState(0);
  const received = useRef(0),
    inflight = useRef(false),
    generation = useRef(0),
    lock = useRef(false),
    current = useRef<View | null>(null);
  const key = `judo.pending.${tatamiId}`;
  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    const gen = generation.current;
    try {
      const v = await request<View>(`/tatamis/${tatamiId}/live`);
      if (gen !== generation.current) return;
      setView(v);
      current.current = v;
      received.current = performance.now();
      setProjection(0);
      setConnected(true);
    } catch (error) {
      if (gen === generation.current) {
        setConnected(false);
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setView(null);
          current.current = null;
          setQueue([]);
        }
      }
    } finally {
      inflight.current = false;
    }
  }, [tatamiId, operator]);
  useEffect(() => {
    generation.current++;
    setView(null);
    current.current = null;
    setQueue([]);
    setConnected(false);
    setError('');
    setPendingInvalid('');
    try {
      const s = sessionStorage.getItem(key);
      setPending(s ? restoreMatchPending(s) : null);
    } catch (e) {
      setPending(null);
      setPendingInvalid(e instanceof Error ? e.message : 'SAVED_MATCH_INVALID');
    }
    void load();
    const timer = setInterval(load, 2000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [load, key]);
  useEffect(() => {
    setQueue(lease.context?.queue ?? []);
  }, [lease.context]);
  useEffect(() => {
    if (!view?.tournamentId) return;
    return subscribeTournament(view.tournamentId, (e) => {
      if (!e.tatamiId || e.tatamiId === tatamiId) void load();
    });
  }, [view?.tournamentId, tatamiId, load]);
  useEffect(() => {
    const timer = setInterval(
      () => setProjection(Math.min(1000, Math.max(0, performance.now() - received.current))),
      100,
    );
    return () => clearInterval(timer);
  }, []);
  function remember(p: PendingMatchCommand | null) {
    if (p) saveMatchPending(sessionStorage, tatamiId, p);
    else sessionStorage.removeItem(key);
    setPending(p);
  }
  async function execute(p: PendingMatchCommand) {
    if (
      lock.current ||
      pendingInvalid ||
      !connected ||
      !lease.connected ||
      lease.busy ||
      lease.pending ||
      lease.corrupt ||
      (operator && (!offline.restored || offline.arming || !!offline.journal))
    )
      return;
    const exactRetry = pending && JSON.stringify(pending) === JSON.stringify(p);
    if (
      !sameGrant(p.payload, lease.grant) &&
      !(exactRetry && mayRetryMatch(p, lease.grant, lease.context?.workRole === 'ADMIN'))
    ) {
      setError(authMessage('CONTROL_GENERATION_STALE', locale === 'kk'));
      return;
    }
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      remember(structuredClone(p));
      generation.current++;
      const result = await deliverMatchPacket(p.contestId, p.payload, (id, payload) =>
        request(`/tatamis/${tatamiId}/live/${id}/command`, payload),
      );
      generation.current++;
      if (result.status === 'CONFIRMED' || p.payload.type === 'START') setQueue([]);
      const old = current.current;
      const next = mergeCommandResponse(old, p.contestId, result);
      if (next !== old) {
        current.current = next;
        setView(next);
        received.current = performance.now();
        setProjection(0);
      }
      remember(null);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        if (!isUnknownMatchFailure(e)) remember(null);
        const messages: Record<string, [string, string]> = {
          VERSION_CONFLICT: [
            'Состояние изменилось в другом пульте. Проверьте обновлённое табло.',
            'Басқа пульт күйді өзгертті. Жаңартылған таблоны тексеріңіз.',
          ],
          PREVIOUS_ROUND_PENDING: [
            'Сначала завершите предыдущий круг всех категорий этого татами.',
            'Алдымен осы татамидегі барлық санаттардың алдыңғы айналымын аяқтаңыз.',
          ],
          QUEUE_ORDER: [
            'Начните следующую встречу в очереди: младшие, затем лёгкие веса.',
            'Кезектегі келесі белдесуді бастаңыз: алдымен кіші жастағылар, содан кейін жеңіл салмақтар.',
          ],
          REST_REQUIRED: [
            'Нужен отдых: 10 минут после предыдущей схватки.',
            'Алдыңғы белдесуден кейін 10 минут демалыс қажет.',
          ],
          MATCH_NOT_READY: [
            'Участники схватки недоступны или их привязки несогласованы. Обновите очередь и обратитесь к администратору.',
            'Белдесу қатысушылары қолжетімсіз немесе олардың байланыстары сәйкес емес. Кезекті жаңартып, әкімшіге хабарласыңыз.',
          ],
          TOURNAMENT_NOT_STARTED: [
            'Администратор должен нажать «Запустить турнир» в рабочей области турнира.',
            'Әкімші турнир бетінде «Турнирді бастау» батырмасын басуы керек.',
          ],
          RESULT_LOCKED: ['Результат уже подтверждён.', 'Нәтиже расталып қойған.'],
          TATAMI_OR_ATHLETE_BUSY: [
            'Татами или спортсмен уже занят.',
            'Татами немесе спортшы бос емес.',
          ],
          INVALID_TRANSITION: [
            'Действие недоступно в текущем состоянии.',
            'Ағымдағы күйде әрекет қолжетімсіз.',
          ],
        };
        const m = messages[e.message];
        setError(m ? text(...m) : authMessage(e.message, locale === 'kk'));
      } else
        setError(
          text(
            'Ответ не получен. Повторите ту же команду кнопкой ниже.',
            'Жауап алынбады. Төмендегі батырмамен сол команданы қайталаңыз.',
          ),
        );
      await load();
      await lease.refresh();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const offline = useOfflineMatch(
    tatamiId,
    operator,
    () => void load(),
    lease.grant,
    !!lease.context || lease.denied,
    device.deviceId,
    { admin: lease.context?.workRole === 'ADMIN', connected: connected && lease.connected, view },
  );
  function send(action: MatchAction) {
    if (offline.journal) {
      void offline.send(action);
      return;
    }
    const m = current.current?.currentMatch;
    if (
      m &&
      !pending &&
      !pendingInvalid &&
      !lock.current &&
      lease.grant &&
      lease.connected &&
      connected &&
      !offline.arming
    )
      void execute({
        contestId: m.id,
        payload: {
          ...action,
          id: crypto.randomUUID(),
          expectedVersion: m.revision,
          ...lease.grant,
        },
      });
  }
  const offlineDisplay = offline.journal
    ? refreshParticipantNames(offline.journal.view, view)
    : null;
  const effectiveView =
    offline.journal && offlineDisplay
      ? {
          ...offlineDisplay,
          currentMatch: { ...offlineDisplay.currentMatch!, state: offline.journal.state },
        }
      : view;
  const m = effectiveView?.currentMatch,
    s = m?.state;
  const shown = s
    ? {
        ...s,
        elapsedMs:
          s.status === 'RUNNING' && !offline.journal
            ? Math.min(s.rules.durationMs, s.elapsedMs + projection)
            : s.elapsedMs,
        goldenMs:
          s.phase === 'GOLDEN' && s.status === 'RUNNING' && !offline.journal
            ? s.goldenMs + projection
            : s.goldenMs,
        hold: s.hold
          ? {
              ...s.hold,
              elapsedMs:
                s.hold.elapsedMs + (s.status === 'RUNNING' && !offline.journal ? projection : 0),
            }
          : null,
      }
    : null;
  const disabled = offline.journal
    ? !offline.ready ||
      offline.journal.opening ||
      !!offline.journal.conflict ||
      offline.journal.packet?.type === 'OFFLINE_RELEASE' ||
      s?.status === 'CONFIRMED'
    : (operator &&
        (!offline.restored ||
          offline.arming ||
          !lease.grant ||
          !lease.connected ||
          !!lease.pending ||
          lease.corrupt ||
          !!pendingInvalid)) ||
      busy ||
      !!pending ||
      !connected;
  const winner = s?.outcome ? (s.outcome.winner === 'WHITE' ? m?.white : m?.blue) : null;
  const statuses: Record<string, [string, string]> = {
    RUNNING: ['Схватка идёт', 'Белдесу жүріп жатыр'],
    PAUSED: ['Время остановлено', 'Уақыт тоқтатылды'],
    PROVISIONAL: ['Проверьте результат', 'Нәтижені тексеріңіз'],
    DECISION: ['Основное время завершено', 'Негізгі уақыт аяқталды'],
    CONFIRMED: ['Результат подтверждён', 'Нәтиже расталды'],
  };
  return (
    <section className={`workspace live-board ${operator ? 'operator-live' : ''}`}>
      {operator && (
        <ControlLeasePanel
          lease={lease}
          view={view}
          offline={!!offline.journal || !!view?.currentMatch?.offlineActive}
          blocked={busy || !connected || offline.arming || !!pending || !!pendingInvalid}
          deviceError={device.error}
          duplicated={device.duplicated}
        />
      )}
      <div className="live-connection" role="status">
        {offline.journal
          ? text('Автономное управление', 'Автономды басқару')
          : operator && !offline.restored
            ? text('Восстанавливаем локальный журнал…', 'Жергілікті журнал қалпына келтірілуде…')
            : connected
              ? operator
                ? text('Сервер подключён', 'Сервер қосылған')
                : text('Обновляется автоматически', 'Автоматты жаңаруда')
              : text(
                  'Нет связи — показано последнее состояние',
                  'Байланыс жоқ — соңғы күй көрсетілген',
                )}{' '}
        · {text('Татами', 'Татами')} {effectiveView?.number ?? '—'}
      </div>
      {operator && !offline.journal && offline.error && (
        <p className="error" role="alert">
          {text(
            'Автономный режим недоступен или локальный журнал не восстановлен: ',
            'Автономды режим қолжетімсіз немесе жергілікті журнал қалпына келмеді: ',
          )}
          {offline.error}
        </p>
      )}
      {operator && offline.journal && (
        <section className="panel offline-status offline-tools" role="status">
          <strong>
            {offline.journal.conflict
              ? text('Синхронизация требует проверки', 'Синхрондау тексеруді қажет етеді')
              : offline.journal.opening
                ? text('Подготавливаем автономный режим…', 'Автономды режим дайындалуда…')
                : offline.online && connected
                  ? text('Автономное табло · связь есть', 'Автономды табло · байланыс бар')
                  : text(
                      'Автономная работа · данные на этом устройстве',
                      'Автономды жұмыс · деректер осы құрылғыда',
                    )}
          </strong>
          <p>
            {text('Не синхронизировано событий', 'Синхрондалмаған оқиғалар')}:{' '}
            {offline.journal.events.length}
          </p>
          <p>
            {text(
              'Держите вкладку табло открытой: скрытую вкладку браузер может замедлять. До синхронизации результат не попадёт в сетку. После перезагрузки время восстанавливается на паузе.',
              'Табло қойындысын ашық ұстаңыз: браузер жасырын қойындыны баяулатуы мүмкін. Синхрондалғанша нәтиже торға түспейді. Қайта жүктегеннен кейін уақыт үзілісте қалпына келеді.',
            )}
          </p>
          {offline.journal.conflict && (
            <p className="error">
              {authMessage(offline.journal.conflict, locale === 'kk')} ·{' '}
              {text(
                'Локальные действия сохранены. Проверьте доступ и обратитесь к администратору.',
                'Жергілікті әрекеттер сақталды. Рұқсатты тексеріп, әкімшіге хабарласыңыз.',
              )}
            </p>
          )}
          {offline.error && (
            <p className="error">
              {text(
                'Локальное сохранение или действие не выполнено: ',
                'Жергілікті сақтау немесе әрекет орындалмады: ',
              )}
              {offline.error}
            </p>
          )}
          {offline.syncError && (
            <p className="error">
              {text('Синхронизация пока не подтверждена: ', 'Синхрондау әлі расталмады: ')}
              {offline.syncError === 'MATCH_RECEIPT_INVALID'
                ? text(
                    'Ответ сервера не удалось проверить. Исходный пакет и журнал сохранены для повтора.',
                    'Сервер жауабын тексеру мүмкін болмады. Бастапқы пакет пен журнал қайталау үшін сақталған.',
                  )
                : offline.syncError}
            </p>
          )}
          <div className="form-actions">
            <button onClick={offline.download}>{text('Скачать журнал', 'Журналды жүктеу')}</button>
            {offline.journal.conflict ? (
              <>
                <button disabled={!offline.ready} onClick={() => void offline.retry()}>
                  {text('Повторить синхронизацию', 'Синхрондауды қайталау')}
                </button>
                {offline.journal.packet && lease.context?.workRole === 'ADMIN' && (
                  <button
                    disabled={!offline.ready || !connected || !lease.connected}
                    onClick={() => void offline.synchronize(false, true)}
                  >
                    {text(
                      'Повторить исходный пакет для проверки ответа',
                      'Жауапты тексеру үшін бастапқы пакетті қайталау',
                    )}
                  </button>
                )}
              </>
            ) : (
              <button
                disabled={
                  !!offline.journal.events.length ||
                  !!offline.journal.packet ||
                  s?.status === 'RUNNING' ||
                  !!s?.hold ||
                  !offline.online
                }
                onClick={() => void offline.synchronize(true)}
              >
                {text(
                  'Синхронизировать и вернуть управление серверу',
                  'Синхрондап, басқаруды серверге қайтару',
                )}
              </button>
            )}
          </div>
          {offline.journal.conflict && (
            <PendingMatchReview
              tournamentId={offline.journal.view.tournamentId}
              contestId={offline.journal.view.currentMatch?.id}
              adminAccess={!!lease.connected && connected && lease.context?.workRole === 'ADMIN'}
              busy={busy || offline.arming}
              reviewEpoch={`${lease.context?.accessRevision}:${view?.currentMatch?.revision}`}
              onExport={offline.download}
              onArchive={offline.archiveConflict}
            />
          )}
        </section>
      )}
      {operator && !offline.journal && m && (
        <section className="panel offline-tools">
          <button
            disabled={
              !connected ||
              offline.arming ||
              busy ||
              !!pending ||
              !lease.grant ||
              !lease.connected ||
              !!lease.pending ||
              !!pendingInvalid ||
              !offline.ready ||
              !s ||
              !['PAUSED', 'DECISION', 'PROVISIONAL'].includes(s.status) ||
              !!s.hold
            }
            onClick={() => effectiveView && void offline.arm(effectiveView)}
          >
            {text('Подготовить автономное табло', 'Автономды таблоны дайындау')}
          </button>
          <p className="field-note">
            {text(
              'Включите на остановленном таймере, пока есть связь. После подготовки текущая схватка сможет продолжаться при потере сервера. Для переноса на другое татами сначала верните управление серверу.',
              'Байланыс бар кезде таймерді тоқтатып қосыңыз. Дайындықтан кейін сервермен байланыс үзілсе де ағымдағы белдесу жалғасады. Басқа татамиге ауыстыру алдында басқаруды серверге қайтарыңыз.',
            )}
          </p>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {operator && pending && (
        <button
          disabled={
            busy ||
            !connected ||
            !lease.connected ||
            !mayRetryMatch(pending, lease.grant, lease.context?.workRole === 'ADMIN') ||
            !offline.restored ||
            !!offline.journal
          }
          onClick={() => void execute(pending)}
        >
          {text('Повторить неподтверждённую команду', 'Жауабы алынбаған команданы қайталау')}
        </button>
      )}
      {operator && (pending || pendingInvalid) && (
        <div className="control-pending">
          <p>
            {text(
              'Исход спортивной команды требует сверки. Её устройство и поколение управления не изменяются при повторе.',
              'Спорттық команданың нәтижесін тексеру керек. Қайталағанда құрылғы мен басқару нұсқасы өзгермейді.',
            )}
          </p>
          {pendingInvalid && (
            <p className="error">{authMessage(pendingInvalid, locale === 'kk')}</p>
          )}
          <PendingMatchReview
            tournamentId={view?.tournamentId ?? lease.context?.tournamentId}
            contestId={
              pending?.contestId ??
              (() => {
                try {
                  const id = JSON.parse(sessionStorage.getItem(key) ?? 'null')?.contestId;
                  return isUuid(id) ? id : undefined;
                } catch {
                  return undefined;
                }
              })()
            }
            adminAccess={connected && lease.connected && lease.context?.workRole === 'ADMIN'}
            busy={busy}
            reviewEpoch={`${lease.context?.accessRevision}:${view?.currentMatch?.revision}`}
            onExport={() => {
              const raw = sessionStorage.getItem(key);
              if (raw === null) return;
              const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = `judo-command-${pending?.payload.id ?? tatamiId}.json`;
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
            onArchive={async (reason, checked, proof) => {
              const raw = sessionStorage.getItem(key);
              if (raw === null) throw new Error('SAVED_MATCH_INVALID');
              const archive = reviewedMatchArchive(
                raw,
                reason,
                checked,
                proof,
                connected && lease.connected && lease.context?.workRole === 'ADMIN',
              );
              sessionStorage.setItem(
                key + '.archive.' + crypto.randomUUID(),
                JSON.stringify(archive),
              );
              remember(null);
              setPendingInvalid('');
              await load();
            }}
          />
        </div>
      )}
      {m && shown ? (
        <>
          <div className={`arena broadcast-board ${operator ? 'operator-board' : ''}`}>
            <header className="arena-header">
              <strong>ТАТАМИ #{effectiveView!.number}</strong>
              <div>{effectiveView!.tournamentName}</div>
              <div className="category">
                <b>{m.key}</b>
                <span>{m.category}</span>
              </div>
            </header>
            <div className="arena-body">
              {(['WHITE', 'BLUE'] as const).map((side) => {
                const p = side === 'WHITE' ? m.white : m.blue;
                return (
                  <div key={side}>
                    <AthleteRow
                      side={side}
                      athlete={{
                        surname: p.lastName,
                        name: p.firstName,
                        club: p.club,
                        color: side === 'WHITE' ? text('БЕЛЫЙ', 'АҚ') : text('СИНИЙ', 'КӨК'),
                        number: side === 'WHITE' ? '1' : '2',
                      }}
                      state={shown}
                      onAward={(kind) => send({ type: 'AWARD', side, kind })}
                      onHold={() => send({ type: 'HOLD', side })}
                      onRevoke={(awardId) => send({ type: 'REVOKE', awardId })}
                      controlsDisabled={disabled}
                      operator={operator}
                    />
                  </div>
                );
              })}
              <div className="timer-zone">
                <div className="timer-category">
                  <strong>{m.category}</strong>
                  <span>{m.key}</span>
                </div>
                <div className="timer-caption">
                  {s!.phase === 'GOLDEN' ? 'GOLDEN SCORE' : text('ОСНОВНОЕ ВРЕМЯ', 'НЕГІЗГІ УАҚЫТ')}
                </div>
                <div className={`timer ${s!.phase === 'GOLDEN' ? 'golden' : ''}`} role="timer">
                  {
                    time(
                      s!.phase === 'GOLDEN'
                        ? shown.goldenMs
                        : shown.rules.durationMs - shown.elapsedMs,
                    ).main
                  }
                  <small>
                    .
                    {
                      time(
                        s!.phase === 'GOLDEN'
                          ? shown.goldenMs
                          : shown.rules.durationMs - shown.elapsedMs,
                      ).tenth
                    }
                  </small>
                </div>
                <p>
                  {offline.journal && s!.status === 'CONFIRMED'
                    ? text(
                        'Сохранено на устройстве — ожидает синхронизации',
                        'Құрылғыда сақталды — синхрондауды күтуде',
                      )
                    : text(...(statuses[s!.status] ?? ['Готово', 'Дайын']))}
                </p>
                {operator && (
                  <div className="timer-controls">
                    <button
                      disabled={
                        disabled ||
                        !['PAUSED', 'RUNNING'].includes(s!.status) ||
                        (s!.status === 'RUNNING' && !!s!.hold)
                      }
                      onClick={() => send({ type: s!.status === 'RUNNING' ? 'STOP' : 'START' })}
                    >
                      {s!.status === 'RUNNING'
                        ? text('Ⅱ Стоп', 'Ⅱ Тоқтату')
                        : text('▶ Продолжить', '▶ Жалғастыру')}
                    </button>
                    {s!.hold && s!.status === 'RUNNING' && (
                      <button disabled={disabled} onClick={() => send({ type: 'TOKETA' })}>
                        TOKETA
                      </button>
                    )}
                    {s!.status === 'DECISION' && (
                      <button disabled={disabled} onClick={() => send({ type: 'GOLDEN' })}>
                        Golden Score
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          {winner && (
            <section className="result">
              <div>
                <p>
                  {offline.journal && s!.status === 'CONFIRMED'
                    ? text('Результат ожидает синхронизации', 'Нәтиже синхрондауды күтуде')
                    : text('Победитель — ожидает подтверждения', 'Жеңімпаз — растауды күтеді')}
                </p>
                <h2>
                  {winner.lastName} {winner.firstName}
                </h2>
                <p>{resultReasonLabel(s!.outcome!.reason, locale)}</p>
              </div>
              {operator && (
                <button
                  disabled={disabled}
                  onClick={() => {
                    if (
                      window.confirm(
                        text(
                          'Подтвердить результат? Он попадёт в протокол и сетку после синхронизации с сервером.',
                          'Нәтижені растайсыз ба? Сервермен синхрондалғаннан кейін хаттама мен торға енгізіледі.',
                        ),
                      )
                    )
                      send({ type: 'CONFIRM' });
                  }}
                >
                  {text('Подтвердить результат', 'Нәтижені растау')}
                </button>
              )}
            </section>
          )}
          {operator && (
            <section className="history">
              <button
                disabled={
                  disabled ||
                  !!s!.hold ||
                  !s!.awards.some(
                    (a) => a.active && (s!.phase === 'REGULAR' || a.phase === 'GOLDEN'),
                  )
                }
                onClick={() => {
                  const a = [...s!.awards]
                    .reverse()
                    .find((a) => a.active && (s!.phase === 'REGULAR' || a.phase === 'GOLDEN'));
                  if (a) send({ type: 'REVOKE', awardId: a.id });
                }}
              >
                ↶ {text('Отменить последнюю оценку', 'Соңғы бағаны жою')}
              </button>
              <details>
                <summary>{text('История оценок', 'Бағалар тарихы')}</summary>
                <h3>{text('Оценки и исправления', 'Бағалар мен түзетулер')}</h3>
                {s!.awards
                  .filter((a) => a.active)
                  .map((a) => (
                    <p key={a.id}>
                      {a.side === 'WHITE' ? text('Белый', 'Ақ') : text('Синий', 'Көк')} · {a.kind}{' '}
                      <button
                        disabled={
                          disabled || !!s!.hold || (s!.phase === 'GOLDEN' && a.phase !== 'GOLDEN')
                        }
                        onClick={() => send({ type: 'REVOKE', awardId: a.id })}
                      >
                        {text('Отменить оценку', 'Бағаны жою')}
                      </button>
                    </p>
                  ))}
              </details>
            </section>
          )}
        </>
      ) : (
        <div className="live-wait">
          <h2>{text('Ожидание следующей схватки', 'Келесі белдесуді күту')}</h2>
          {view?.lastResult && (
            <p>
              {text('Последняя схватка', 'Соңғы белдесу')}:{' '}
              {operator && <>{view.lastResult.key} · </>}
              {view.lastResult.winner?.lastName} {view.lastResult.winner?.firstName} ·{' '}
              {resultReasonLabel(view.lastResult.resultReason, locale)}
            </p>
          )}
          {view?.tournamentStatus === 'DRAFT' && (
            <p>
              {text(
                'Подготовка турнира. Администратор запускает турнир после проверки сеток.',
                'Турнирге дайындық. Әкімші торларды тексергеннен кейін турнирді бастайды.',
              )}
            </p>
          )}
          {view?.tournamentStatus === 'FINISHED' && (
            <p>
              {text(
                'Все результаты подтверждены. Турнир завершён.',
                'Барлық нәтижелер расталған. Турнир аяқталды.',
              )}
            </p>
          )}
          {operator && queue[0] && view?.tournamentStatus === 'RUNNING' && (
            <>
              <p>
                {queue[0].category} · {queue[0].key}
              </p>
              <button
                disabled={disabled || queue[0].blockedByRound}
                onClick={() =>
                  void execute({
                    contestId: queue[0].id,
                    payload: {
                      id: crypto.randomUUID(),
                      expectedVersion: queue[0].revision,
                      type: 'START',
                      ...lease.grant!,
                    },
                  })
                }
              >
                {queue[0].blockedByRound
                  ? text(
                      'Ждём завершения предыдущего круга',
                      'Алдыңғы айналымның аяқталуын күтеміз',
                    )
                  : text('▶ Начать следующую схватку', '▶ Келесі белдесуді бастау')}
              </button>
            </>
          )}
        </div>
      )}
      {operator && (
        <p className="field-note">
          {text(
            'Пользовательский профиль: 3 Shido, 2 Waza-ari, удержание 5/10/20 с; отдых 10 минут. Соответствие IJF не подтверждено. Для работы без сервера заранее подготовьте автономный режим на этом устройстве.',
            'Бапталатын профиль: 3 Shido, 2 Waza-ari, ұстап тұру 5/10/20 с; демалыс 10 минут. IJF сәйкестігі расталмаған. Серверсіз жұмыс үшін осы құрылғыда автономды режимді алдын ала дайындаңыз.',
          )}
        </p>
      )}
    </section>
  );
}
