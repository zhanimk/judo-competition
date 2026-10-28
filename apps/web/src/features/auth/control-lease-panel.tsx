'use client';
import { useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import type { View } from '../live/live-board';
import { time } from '../scoreboard/lib/format-time';
import { authMessage } from './messages';
import type { useControlLease } from './use-control-lease';
export function ControlLeasePanel({
  lease,
  view,
  offline,
  blocked,
  deviceError,
  duplicated,
}: {
  lease: ReturnType<typeof useControlLease>;
  view: View | null;
  offline: boolean;
  blocked: boolean;
  deviceError: string;
  duplicated: boolean;
}) {
  const { text, locale } = useLanguage();
  const [takeover, setTakeover] = useState(false),
    [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const c = lease.context?.control,
    match = view?.currentMatch;
  const stopped = !match || (match.state.status !== 'RUNNING' && !match.state.hold);
  const disabled =
    blocked ||
    !lease.connected ||
    !lease.restored ||
    lease.busy ||
    !!lease.pending ||
    lease.corrupt ||
    !!deviceError;
  return (
    <section
      className={`panel control-lease ${c?.owned && c.holderValid ? 'control-lease-owned' : ''}`}
      aria-label={text('Управление табло', 'Таблоны басқару')}
    >
      <div className="control-lease-heading">
        <div>
          <h2>{text('Управление табло', 'Таблоны басқару')}</h2>
          <p>
            {c?.owned && c.holderValid
              ? text('Эта вкладка управляет табло.', 'Бұл қойынды таблоны басқарады.')
              : c?.held
                ? `${text('Управление занято', 'Басқару бос емес')}: ${c.holderName ?? '—'}`
                : text(
                    'Управление свободно. Возьмите его перед началом работы.',
                    'Басқару бос. Жұмыс алдында басқаруды алыңыз.',
                  )}
          </p>
        </div>
        {c && !c.held && (
          <button disabled={disabled || offline} onClick={() => lease.command('CLAIM')}>
            {text('Взять управление', 'Басқаруды алу')}
          </button>
        )}
        {c?.owned && c.holderValid && (
          <button
            disabled={disabled || !stopped || offline}
            onClick={() => lease.command('RELEASE')}
          >
            {text('Освободить управление', 'Басқаруды босату')}
          </button>
        )}
        {c?.held && !c.owned && lease.context?.workRole === 'ADMIN' && (
          <button
            disabled={disabled || offline}
            onClick={() => {
              setTakeover(!takeover);
              setConfirmed(false);
              setReason('');
            }}
          >
            {text('Передать управление этой вкладке', 'Басқаруды осы қойындыға беру')}
          </button>
        )}
      </div>
      {duplicated && (
        <p className="field-note">
          {text(
            'Открыта отдельная вкладка. Для неё нужно явно взять управление; другая вкладка продолжает работать.',
            'Бөлек қойынды ашылды. Оған басқаруды бөлек алу керек; басқа қойынды жұмысын жалғастырады.',
          )}
        </p>
      )}
      {c?.held && !c.holderValid && (
        <p className="field-note">
          {text(
            'Доступ предыдущего судьи истёк или отозван. Управление передаёт администратор.',
            'Алдыңғы төрешінің рұқсаты аяқталған немесе жойылған. Басқаруды әкімші береді.',
          )}
        </p>
      )}
      {c?.owned && (!stopped || offline) && (
        <p className="field-note">
          {text(
            'Перед освобождением остановите время, завершите удержание и синхронизируйте автономную схватку.',
            'Босату алдында уақытты тоқтатыңыз, ұстап тұруды аяқтаңыз және автономды белдесуді синхрондаңыз.',
          )}
        </p>
      )}
      {takeover && c?.held && !c.owned && lease.context?.workRole === 'ADMIN' && (
        <form
          className="control-takeover"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmed && reason.trim().length >= 3) lease.command('TAKEOVER', reason.trim());
          }}
        >
          <p>
            <strong>{text('Текущая встреча', 'Ағымдағы белдесу')}:</strong>{' '}
            {match
              ? `${match.key} · ${match.category} · ${match.white?.lastName ?? '—'} / ${match.blue?.lastName ?? '—'}`
              : text('Нет активной встречи', 'Белсенді белдесу жоқ')}
          </p>
          {match && (
            <p>
              {text('Время', 'Уақыт')}:{' '}
              {
                time(
                  match.state.phase === 'GOLDEN'
                    ? match.state.goldenMs
                    : match.state.rules.durationMs - match.state.elapsedMs,
                ).main
              }
              {match.state.hold &&
                ` · ${text('Удержание', 'Ұстап тұру')}: ${time(match.state.hold.elapsedMs).main}`}
            </p>
          )}
          <p className="info-note">
            {text(
              'Встреча будет остановлена, время и удержание нужно сверить. Удержание сохраняется. Старая вкладка потеряет управление.',
              'Белдесу тоқтатылады, уақыт пен ұстап тұруды тексеру керек. Ұстап тұру сақталады. Ескі қойынды басқаруды жоғалтады.',
            )}
          </p>
          <label>
            {text('Причина передачи', 'Беру себебі')}
            <textarea
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setConfirmed(false);
              }}
            />
          </label>
          <label className="control-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {text(
              'Подтверждаю передачу и сверку времени и удержания.',
              'Беру мен уақыт және ұстап тұруды тексеруді растаймын.',
            )}
          </label>
          <button disabled={disabled || offline || !confirmed || reason.trim().length < 3}>
            {text('Подтвердить передачу', 'Беруді растау')}
          </button>
        </form>
      )}
      {offline && c?.held && !c.owned && (
        <p className="field-note">
          {text(
            'Автономная схватка удерживает управление. Администратор сначала проверяет журнал и отзывает автономное управление в центре татами.',
            'Автономды белдесу басқаруды ұстап тұр. Әкімші алдымен журналды тексеріп, татами орталығында автономды басқаруды қайтарып алады.',
          )}
        </p>
      )}
      {(deviceError || lease.error || lease.denied) && (
        <p className="error-box" role="alert">
          {authMessage(deviceError || lease.error || 'AUTH_REQUIRED', locale === 'kk')}
        </p>
      )}
      {(lease.pending || lease.corrupt) && (
        <div className="control-pending" role="status">
          <p>
            {text(
              'Исход команды управления не установлен. Новые команды заблокированы; повтор использует исходные данные.',
              'Басқару командасының нәтижесі анықталмады. Жаңа командалар бұғатталған; қайталау бастапқы деректерді қолданады.',
            )}
          </p>
          {lease.pending && (
            <button
              disabled={
                lease.busy || !lease.connected || lease.pending.command.deviceId !== lease.deviceId
              }
              onClick={lease.retry}
            >
              {text('Повторить ту же команду', 'Сол команданы қайталау')}
            </button>
          )}
          <button
            disabled={lease.busy}
            onClick={() => {
              if (
                window.confirm(
                  text(
                    'Сохранить команду в локальном архиве для сверки и обновить состояние? Архивирование не отменяет команду на сервере.',
                    'Команданы тексеру үшін жергілікті мұрағатта сақтап, күйді жаңартасыз ба? Мұрағаттау сервердегі команданы жоймайды.',
                  ),
                )
              ) {
                lease.archivePending();
                void lease.refresh();
              }
            }}
          >
            {text('Архивировать для сверки', 'Тексеру үшін мұрағаттау')}
          </button>
        </div>
      )}
    </section>
  );
}
