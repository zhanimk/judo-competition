'use client';
import { useState, useRef } from 'react';
import { useMatch } from '../model/use-match';
import { demoRules } from '../fixtures/rules';
import { athletes } from '../fixtures/athletes';
import { russian, statuses, reasons } from '../model/labels';
import { AthleteRow } from './athlete-row';
import { MatchTimer } from './match-timer';
import '../scoreboard.css';
export function Scoreboard() {
  const { state, send, reset, error } = useMatch(demoRules);
  const [operator, setOperator] = useState(true),
    [dark, setDark] = useState(false);
  const [dialog, setDialog] = useState<
    { kind: 'reset' } | { kind: 'revoke'; id: string; label: string } | null
  >(null);
  const modal = useRef<HTMLDialogElement>(null);
  const open = (value: NonNullable<typeof dialog>) => {
    setDialog(value);
    modal.current?.showModal();
  };
  const close = () => {
    modal.current?.close();
    setDialog(null);
  };
  return (
    <div className={`workspace ${dark ? 'dark' : ''} ${operator ? 'operator' : 'viewer'}`}>
      <nav className="toolbar">
        <a href="/" className="wordmark">
          <span className="logo">J</span> JUDO<span className="wordmark-light">COMPETITION</span>
        </a>
        <div className="tools">
          <button onClick={() => setDark(!dark)}>{dark ? 'Светлая тема' : 'Тёмная тема'}</button>
          <button onClick={() => setOperator(!operator)}>
            {operator ? 'Зрительский вид' : 'Пульт оператора'}
          </button>
        </div>
      </nav>
      <main>
        <div className="page-intro">
          <div>
            <p className="eyebrow">УПРАВЛЕНИЕ СХВАТКОЙ</p>
            <h1>Судейское табло</h1>
          </div>
          <span className="demo-badge">ДЕМОНСТРАЦИЯ · ЛОКАЛЬНО</span>
        </div>
        <div className={`arena broadcast-board ${operator ? 'operator-board' : ''}`}>
          <header className="arena-header">
            <strong>
              ТАТАМИ <span>#1</span>
            </strong>
            <div>
              Кубок Алматы <span>Демонстрационный турнир</span>
            </div>
            <div className="category">
              <b>Схватка 001</b>
              <span>Учебный профиль · 4 минуты</span>
            </div>
          </header>
          <div className="arena-body">
            <AthleteRow
              side="WHITE"
              athlete={athletes.WHITE}
              state={state}
              onAward={(kind) => send({ type: 'AWARD', side: 'WHITE', kind })}
              onHold={() => send({ type: 'HOLD', side: 'WHITE' })}
              operator={operator}
            />
            <AthleteRow
              side="BLUE"
              athlete={athletes.BLUE}
              state={state}
              onAward={(kind) => send({ type: 'AWARD', side: 'BLUE', kind })}
              onHold={() => send({ type: 'HOLD', side: 'BLUE' })}
              operator={operator}
            />
            <MatchTimer state={state} send={send} operator={operator} />
          </div>
          <footer className="arena-footer">
            <span>БЕЛЫЙ / АҚ · СИНИЙ / КӨК</span>
            <span>IPPON · WAZA-ARI · YUKO · SHIDO</span>
          </footer>
        </div>
        {state.outcome && (
          <section className="result" aria-live="polite">
            <div>
              <p className="eyebrow">{statuses[state.status]}</p>
              <h2>
                {athletes[state.outcome.winner].surname} {athletes[state.outcome.winner].name}
              </h2>
              <p>{reasons[state.outcome.reason]}</p>
            </div>
            {operator && state.status === 'PROVISIONAL' && (
              <button className="primary" onClick={() => send({ type: 'CONFIRM' })}>
                Подтвердить деморезультат
              </button>
            )}
          </section>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {operator && (
          <section className="history">
            <div className="history-heading">
              <h2>Действия судьи</h2>
              <span>{state.awards.length} записей</span>
            </div>
            {!state.awards.length ? (
              <p className="empty">Оценок пока нет. Начните схватку, чтобы управлять табло.</p>
            ) : (
              <ol>
                {[...state.awards].reverse().map((a) => (
                  <li key={a.id}>
                    <span>
                      {athletes[a.side].surname} · {russian[a.kind]}
                      {!a.active ? ' · отменено' : ''}
                    </span>
                    {a.active && (
                      <button
                        disabled={
                          state.status === 'CONFIRMED' || state.phase === 'GOLDEN' || !!state.hold
                        }
                        onClick={() =>
                          open({
                            kind: 'revoke',
                            id: a.id,
                            label: `${russian[a.kind]} — ${athletes[a.side].surname}`,
                          })
                        }
                      >
                        Исправить
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
        <div className="prototype-note">
          <p>
            Учебные данные · Не официальный профиль IJF
            <br />
            Состояние хранится только в этой вкладке и сбрасывается при обновлении страницы.
          </p>
          {operator && <button onClick={() => open({ kind: 'reset' })}>Новая демонстрация</button>}
        </div>
      </main>
      <dialog ref={modal} onCancel={() => setDialog(null)}>
        <h2>{dialog?.kind === 'reset' ? 'Начать заново?' : 'Отменить действие?'}</h2>
        <p>
          {dialog?.kind === 'revoke'
            ? `${dialog.label}. Время останется остановленным, запись сохранится в истории.`
            : 'Текущие демонстрационные данные будут удалены.'}
        </p>
        <div>
          <button onClick={close}>Назад</button>
          <button
            className="primary"
            onClick={() => {
              if (dialog?.kind === 'reset') reset();
              else if (dialog) send({ type: 'REVOKE', awardId: dialog.id });
              close();
            }}
          >
            Подтвердить
          </button>
        </div>
      </dialog>
    </div>
  );
}
