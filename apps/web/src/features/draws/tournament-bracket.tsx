'use client';
import { resultReasonLabel } from '../live/labels';
import { useMemo, useRef, useState } from 'react';
import type { Draw, Slot } from '@judo/engine/draw';
import type { Entry } from '../tournaments/types';
import { useLanguage } from '../../shared/i18n/provider';
import { bracketNodes, layoutBracket, CARD_WIDTH, CARD_HEIGHT, COLUMN_GAP } from './bracket-layout';
import './bracket.css';
type Contest = {
  state?: import('@judo/engine/match').MatchState | null;
  id: string;
  key: string;
  status: string;
  tatamiId: string | null;
  whiteEntryId?: string | null;
  blueEntryId?: string | null;
  winnerEntryId?: string | null;
  resultReason?: string | null;
};
export function TournamentBracket({
  draw,
  entries,
  contests,
  tatamis,
  busy,
  canAssign,
  onAssign,
  readOnly = false,
}: {
  readOnly?: boolean;
  draw: Draw;
  entries: Entry[];
  contests: Contest[];
  tatamis: { id: string; number: number }[];
  busy: boolean;
  canAssign: boolean;
  onAssign: (id: string) => void;
}) {
  const { text, locale } = useLanguage();
  const [section, setSection] = useState('all'),
    [scale, setScale] = useState(1),
    [selected, setSelected] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const size =
    draw.algorithm === 'custom-pools-knockout-v1' ? (draw.pools?.length ?? 1) * 2 : draw.size;
  const rounds = Math.log2(size);
  const nodes = useMemo(
    () =>
      bracketNodes(draw).map((n) => {
        const c = contests.find((c) => c.key === n.matchId);
        return {
          ...n,
          white: c?.whiteEntryId ? { entryId: c.whiteEntryId } : n.white,
          blue: c?.blueEntryId ? { entryId: c.blueEntryId } : n.blue,
        };
      }),
    [draw, contests],
  );
  const group = ['A', 'B', 'C', 'D'].indexOf(section);
  const pools = size >= 16;
  const view =
    group >= 0 && pools
      ? {
          startRound: 1,
          endRound: rounds - 2,
          startLeaf: (group * size) / 4,
          leafCount: size / 4,
        }
      : section === 'medals' && pools
        ? { startRound: rounds - 1, endRound: rounds, startLeaf: 0, leafCount: size }
        : { startRound: 1, endRound: rounds, startLeaf: 0, leafCount: size };
  const layout = layoutBracket(nodes, view);
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const roundName = (r: number) =>
    r === rounds
      ? text('Финал', 'Финал')
      : r === rounds - 1
        ? text('Полуфиналы', 'Жартылай финал')
        : r === rounds - 2
          ? text('Четвертьфиналы', 'Ширек финал')
          : `1/${2 ** (rounds - r)}`;
  function athlete(slot: Slot | null, side: 'white' | 'blue', bye: boolean) {
    const entry = slot && 'entryId' in slot ? entryMap.get(slot.entryId) : undefined;
    return (
      <div className={`bracket-athlete ${side} ${!entry ? 'unresolved' : ''}`}>
        <span
          className="bracket-side"
          aria-label={side === 'white' ? text('Белый', 'Ақ') : text('Синий', 'Көк')}
        >
          {side === 'white' ? text('Б', 'А') : text('С', 'К')}
        </span>
        <span className="bracket-person">
          {entry ? (
            <>
              <strong title={`${entry.lastName} ${entry.firstName}`}>
                {entry.lastName} {entry.firstName}
              </strong>
              <small title={entry.club}>{entry.club}</small>
            </>
          ) : slot ? (
            <>
              <strong>{slotLabel(slot)}</strong>
              <small>{text('Ожидаем результат', 'Нәтижені күтеміз')}</small>
            </>
          ) : (
            <>
              <strong>BYE</strong>
              <small>{text('Без соперника', 'Қарсылассыз')}</small>
            </>
          )}
        </span>
        {bye && entry && (
          <span className="bracket-pass" title={text('Проход без схватки', 'Белдесусіз өту')}>
            ↗
          </span>
        )}
      </div>
    );
  }
  function slotLabel(slot: Slot | null) {
    if (!slot) return 'BYE';
    if ('winnerOf' in slot) return text('Победитель ', 'Жеңімпаз ') + slot.winnerOf;
    if ('loserOf' in slot) return text('Проигравший ', 'Жеңілген ') + slot.loserOf;
    if ('pool' in slot) return text('Группа ', 'Топ ') + slot.pool + ' · ' + slot.place;
    const entry = entryMap.get(slot.entryId);
    return entry
      ? `${entry.lastName} ${entry.firstName}, ${entry.club}`
      : text('Участник', 'Қатысушы');
  }
  const detail = layout.cards.find((c) => c.id === selected);
  return (
    <div className="bracket-widget">
      <div className="bracket-toolbar">
        <div
          className="bracket-sections"
          role="group"
          aria-label={text('Часть сетки', 'Тор бөлігі')}
        >
          {[
            ['all', text('Вся сетка', 'Толық тор')],
            ...(pools ? ['A', 'B', 'C', 'D'].map((v) => [v, text('Группа', 'Топ') + ' ' + v]) : []),
            ...(pools ? [['medals', text('Финальный этап', 'Финалдық кезең')]] : []),
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={section === value}
              onClick={() => {
                setSection(value);
                setSelected(null);
                viewport.current?.scrollTo({ top: 0, left: 0 });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          className="bracket-zoom"
          role="group"
          aria-label={text('Масштаб сетки', 'Тор масштабы')}
        >
          <button
            type="button"
            aria-label={text('Уменьшить', 'Кішірейту')}
            disabled={scale <= 0.6}
            onClick={() => setScale((v) => Math.max(0.6, Math.round((v - 0.1) * 10) / 10))}
          >
            −
          </button>
          <button
            type="button"
            title={text('Вернуть 100%', '100% қалпына келтіру')}
            onClick={() => setScale(1)}
          >
            {Math.round(scale * 100)}%
          </button>
          <button
            type="button"
            aria-label={text('Увеличить', 'Үлкейту')}
            disabled={scale >= 1.2}
            onClick={() => setScale((v) => Math.min(1.2, Math.round((v + 0.1) * 10) / 10))}
          >
            +
          </button>
        </div>
      </div>
      <div className="bracket-caption">
        <span className="bracket-legend">
          <i className="white" />
          {text('Белый', 'Ақ')}
          <i className="blue" />
          {text('Синий', 'Көк')}
          <i className="gold" />
          BYE
        </span>
        <span>
          {text(
            'Прокрутка ↔ · выберите карточку для подробностей',
            'Айналдыру ↔ · мәлімет үшін карточканы таңдаңыз',
          )}
        </span>
      </div>
      <div
        className="bracket-viewport"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label={text(
          'Турнирная сетка с горизонтальной и вертикальной прокруткой',
          'Көлденең және тік айналдырылатын турнир торы',
        )}
      >
        <div
          style={{
            width: layout.width * scale + 40,
            height: layout.height * scale + 32,
            position: 'relative',
          }}
        >
          <div
            className="bracket-canvas"
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${scale})`,
              transformOrigin: 'top left',
            }}
          >
            {Array.from({ length: view.endRound - view.startRound + 1 }, (_, i) => {
              const r = view.startRound + i;
              return (
                <h3
                  className={`bracket-round ${r === rounds ? 'final' : ''}`}
                  key={r}
                  style={{ left: i * (CARD_WIDTH + COLUMN_GAP), width: CARD_WIDTH }}
                >
                  <span>{roundName(r)}</span>
                  <small>{layout.cards.filter((c) => c.round === r).length}</small>
                </h3>
              );
            })}
            <svg
              className="bracket-lines"
              width={layout.width}
              height={layout.height}
              aria-hidden="true"
            >
              {layout.lines.map((line) => (
                <path key={line.from} d={line.path} />
              ))}
            </svg>
            {layout.cards.map((c) => {
              const contest = contests.find((m) => m.key === c.matchId);
              const mat = tatamis.find((t) => t.id === contest?.tatamiId);
              return (
                <article
                  key={c.id}
                  className={`bracket-match ${c.round === rounds ? 'final' : ''} ${!c.matchId ? 'bye' : ''} ${selected === c.id ? 'selected' : ''}`}
                  style={{ left: c.x, top: c.y, width: CARD_WIDTH, height: CARD_HEIGHT }}
                >
                  <button
                    type="button"
                    className="bracket-card-main"
                    aria-pressed={selected === c.id}
                    onClick={() => setSelected((v) => (v === c.id ? null : c.id))}
                    aria-label={`${roundName(c.round)} · ${c.id}. ${slotLabel(c.white)} / ${slotLabel(c.blue)}`}
                  >
                    <span className="bracket-match-heading">
                      <b>{c.matchId ?? 'BYE'}</b>
                      <span>
                        {c.round === rounds
                          ? text('Финал', 'Финал')
                          : !c.matchId
                            ? text('Свободный проход', 'Бос өту')
                            : text('Схватка', 'Белдесу')}
                      </span>
                    </span>
                    {athlete(c.white, 'white', !c.matchId)}
                    {athlete(c.blue, 'blue', !c.matchId)}
                  </button>
                  <div className="bracket-match-footer">
                    {!c.matchId ? (
                      <span>{text('Проход без схватки', 'Белдесусіз өту')}</span>
                    ) : contest?.status === 'CONFIRMED' ? (
                      <span className="bracket-assigned">
                        {text('Победитель', 'Жеңімпаз')}:{' '}
                        {entryMap.get(contest.winnerEntryId ?? '')?.lastName} ·{' '}
                        {resultReasonLabel(contest.resultReason, locale)}
                      </span>
                    ) : mat ? (
                      <span className="bracket-assigned">Татами {mat.number}</span>
                    ) : contest?.status === 'READY' && !readOnly ? (
                      <button
                        type="button"
                        disabled={busy || !canAssign}
                        aria-label={`${text('Назначить схватку', 'Белдесуді тағайындау')} ${c.id}`}
                        onClick={() => onAssign(contest.id)}
                      >
                        {text('В очередь', 'Кезекке')} ↗
                      </button>
                    ) : (
                      <span>
                        {contest?.status === 'READY'
                          ? text('Не назначено', 'Тағайындалмаған')
                          : contests.length
                            ? text('Ожидаем победителей', 'Жеңімпаздарды күтеміз')
                            : text('Предварительная сетка', 'Алдын ала тор')}
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </div>
      {detail && (
        <section className="bracket-details" aria-live="polite">
          <div>
            <strong>
              {roundName(detail.round)} · {detail.matchId ?? 'BYE'}
            </strong>
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label={text('Закрыть подробности', 'Мәліметтерді жабу')}
            >
              ×
            </button>
          </div>
          {[detail.white, detail.blue].map((slot, i) => {
            const e = slot && 'entryId' in slot ? entryMap.get(slot.entryId) : null;
            return (
              <p key={i}>
                <b>{i === 0 ? text('Белый', 'Ақ') : text('Синий', 'Көк')}: </b>
                {e
                  ? `${e.lastName} ${e.firstName} · ${e.club}`
                  : slot && 'winnerOf' in slot
                    ? `${text('Победитель', 'Жеңімпаз')} ${slot.winnerOf}`
                    : 'BYE'}
              </p>
            );
          })}
        </section>
      )}
      {pools && group >= 0 && (
        <p className="field-note">
          {text(
            'A–D — части одной сетки. Их победители проходят в полуфиналы: A встречается с B, C — с D.',
            'A–D — бір тордың бөліктері. Жеңімпаздар жартылай финалға өтеді: A — B, C — D.',
          )}
        </p>
      )}
    </div>
  );
}
