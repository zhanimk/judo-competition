'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLanguage } from '../../shared/i18n/provider';
import { request } from '../tournaments/api';
import { ScoreSummary } from './results-table';
import { matchRecoveryProof, type MatchRecoveryProof } from './pending-command';

export function PendingMatchReview({
  tournamentId,
  contestId,
  adminAccess,
  busy,
  reviewEpoch,
  onExport,
  onArchive,
}: {
  tournamentId: string | undefined;
  contestId: string | undefined;
  adminAccess: boolean;
  busy: boolean;
  reviewEpoch: string;
  onExport: () => void;
  onArchive: (reason: string, checked: boolean, proof: MatchRecoveryProof) => Promise<void>;
}) {
  const { text } = useLanguage();
  const [open, setOpen] = useState(false),
    [reason, setReason] = useState(''),
    [checked, setChecked] = useState(false),
    [proof, setProof] = useState<MatchRecoveryProof | null>(null),
    [reading, setReading] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setChecked(false);
    setProof(null);
  }, [reviewEpoch, adminAccess, contestId, tournamentId]);
  async function refresh() {
    if (!adminAccess || !tournamentId || !contestId || reading) return;
    setReading(true);
    setChecked(false);
    setError('');
    try {
      setProof(
        matchRecoveryProof(
          contestId,
          await request(`/tournaments/${tournamentId}/control/${contestId}/impact`),
        ),
      );
    } catch {
      setProof(null);
      setError(
        text(
          'Не удалось получить актуальную встречу. Исходная запись сохранена.',
          'Өзекті белдесуді жүктеу мүмкін болмады. Бастапқы жазба сақталған.',
        ),
      );
    } finally {
      setReading(false);
    }
  }
  async function archive() {
    if (!adminAccess || !tournamentId || !contestId || !proof || !checked || reading) return;
    setReading(true);
    setError('');
    try {
      const current = matchRecoveryProof(
        contestId,
        await request(`/tournaments/${tournamentId}/control/${contestId}/impact`),
      );
      if (current.impactToken !== proof.impactToken) {
        setProof(current);
        setChecked(false);
        setError(
          text(
            'Встреча изменилась. Сверьте обновлённые данные и подтвердите решение заново.',
            'Белдесу өзгерді. Жаңартылған деректерді салыстырып, шешімді қайта растаңыз.',
          ),
        );
        return;
      }
      await onArchive(reason, checked, current);
    } catch {
      setError(
        text(
          'Сверка или сохранение архива не выполнены. Исходная запись и блокировка сохранены.',
          'Салыстыру немесе мұрағаттау орындалмады. Бастапқы жазба мен бұғаттау сақталған.',
        ),
      );
    } finally {
      setReading(false);
    }
  }
  return (
    <section className="match-recovery">
      <p>
        {text(
          'Новые спортивные действия заблокированы до проверенного ответа или решения администратора. Исходная запись не отменяется архивированием.',
          'Тексерілген жауап не әкімшінің шешімі алынғанша жаңа спорттық әрекеттер бұғатталған. Мұрағаттау бастапқы команданы қайтармайды.',
        )}
      </p>
      <div className="form-actions">
        <button
          disabled={busy || reading}
          onClick={() => {
            try {
              onExport();
            } catch {
              setError(
                text(
                  'Не удалось скачать исходную запись. Она сохранена без изменений.',
                  'Бастапқы жазбаны жүктеу мүмкін болмады. Ол өзгеріссіз сақталған.',
                ),
              );
            }
          }}
        >
          {text('Скачать исходную запись', 'Бастапқы жазбаны жүктеу')}
        </button>
        {adminAccess && (
          <button
            disabled={busy || reading || !contestId}
            onClick={() => {
              setOpen(!open);
              void refresh();
            }}
          >
            {text('Разобрать вручную', 'Қолмен тексеру')}
          </button>
        )}
        {tournamentId && (
          <Link href={`/tournaments/${tournamentId}`}>
            {text('К турниру: центр татами', 'Турнирге: татами орталығы')}
          </Link>
        )}
      </div>
      {!adminAccess && (
        <p>
          {text(
            'Передайте исходную запись администратору для сверки.',
            'Бастапқы жазбаны салыстыру үшін әкімшіге беріңіз.',
          )}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {open && adminAccess && (
        <fieldset disabled={busy || reading}>
          <legend>
            {text('Решение администратора после сверки', 'Салыстырудан кейінгі әкімшінің шешімі')}
          </legend>
          <p>
            {text('Исходная встреча', 'Бастапқы белдесу')}: {contestId}
          </p>
          <button onClick={() => void refresh()}>
            {text('Обновить данные для сверки', 'Салыстыру деректерін жаңарту')}
          </button>
          {proof && (
            <div>
              <p>
                {text('Версия встречи', 'Белдесу нұсқасы')}: {proof.revision} ·{' '}
                {proof.clockState?.status ?? text('Не начата', 'Басталмаған')}
              </p>
              {proof.clockState && (
                <>
                  <p>
                    {proof.clockState.phase} · {text('Победитель', 'Жеңімпаз')}:{' '}
                    {proof.clockState.outcome?.winner ?? '—'}
                  </p>
                  <p>{text('Белый', 'Ақ')}</p>
                  <ScoreSummary state={proof.clockState} side="WHITE" />
                  <p>{text('Синий', 'Көк')}</p>
                  <ScoreSummary state={proof.clockState} side="BLUE" />
                </>
              )}
              {!!proof.dependent.length && (
                <p>
                  {text('Зависимые встречи', 'Тәуелді белдесулер')}:{' '}
                  {proof.dependent.map((row) => `${row.key} (${row.status})`).join(', ')}
                </p>
              )}
              {proof.clockState?.status === 'RUNNING' && (
                <p className="error">
                  {text(
                    'Для сверки остановите встречу через действующий пульт управления.',
                    'Салыстыру үшін белдесуді қолданыстағы пульт арқылы тоқтатыңыз.',
                  )}
                </p>
              )}
            </div>
          )}
          <label>
            {text('Что проверено и принятое решение', 'Не тексерілді және қабылданған шешім')}
            <textarea
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label className="match-recovery-check">
            <input
              type="checkbox"
              checked={checked}
              disabled={!proof || proof.clockState?.status === 'RUNNING'}
              onChange={(event) => setChecked(event.target.checked)}
            />
            {text(
              'Я сверил исходную встречу и зависимые результаты. Разрешаю переход к серверному состоянию; архивирование не отменяет команду.',
              'Бастапқы белдесу мен тәуелді нәтижелерді салыстырдым. Сервер күйіне өтуге рұқсат беремін; мұрағаттау команданы қайтармайды.',
            )}
          </label>
          <button
            disabled={
              !proof ||
              proof.clockState?.status === 'RUNNING' ||
              !checked ||
              reason.trim().length < 3
            }
            onClick={() => void archive()}
          >
            {text(
              'Сохранить решение и исходную запись в архиве',
              'Шешім мен бастапқы жазбаны мұрағатта сақтау',
            )}
          </button>
        </fieldset>
      )}
    </section>
  );
}
