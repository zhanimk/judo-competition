'use client';
import { useState } from 'react';
import { request } from '../tournaments/api';
import { useLanguage } from '../../shared/i18n/provider';
import type { Review } from './tiebreak-review';

export function ManualTieDecision({
  categoryId,
  review,
  name,
  disabled,
  canApprove,
  onApprove,
}: {
  categoryId: string;
  review: Review;
  name: (id: string) => string;
  disabled: boolean;
  canApprove: boolean;
  onApprove: (review: Review) => Promise<void>;
}) {
  const { text } = useLanguage();
  const [order, setOrder] = useState<string[]>(review.members.map(() => ''));
  const [preview, setPreview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid =
    order.every((id) => review.members.includes(id)) && new Set(order).size === order.length;
  async function check() {
    if (busy || disabled || !valid) return;
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const result = await request<{ reviews: Review[] }>(
        `/categories/${categoryId}/draw/tiebreak-impact`,
        {
          procedure: 'ORDERED_PLACES',
          parent: review.parent,
          ...(review.pool ? { pool: review.pool } : {}),
          members: order,
        },
      );
      setPreview(result.reviews[0]);
    } catch {
      setError(
        text(
          'Сверка не получена. Обновите данные и повторите.',
          'Тексеру алынбады. Деректерді жаңартып, қайталаңыз.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="manual-tie-decision">
      <h4>{text('Указать порядок мест вручную', 'Орын ретін қолмен белгілеу')}</h4>
      <p>
        {text(
          'Выберите всех участников от лучшего к худшему внутри равной группы. Остальные места не меняются.',
          'Тең топтағы барлық қатысушыларды үздігінен бастап таңдаңыз. Қалған орындар өзгермейді.',
        )}
      </p>
      {order.map((id, index) => (
        <label key={index}>
          {text('Позиция среди равных', 'Теңдер арасындағы орны')} {index + 1}
          <select
            value={id}
            disabled={disabled || busy}
            onChange={(e) => {
              const next = [...order];
              next[index] = e.target.value;
              setOrder(next);
              setPreview(null);
            }}
          >
            <option value="">{text('Выберите спортсмена', 'Спортшыны таңдаңыз')}</option>
            {review.members.map((member) => (
              <option
                key={member}
                value={member}
                disabled={member !== id && order.includes(member)}
              >
                {name(member)}
              </option>
            ))}
          </select>
        </label>
      ))}
      {error && <p role="alert">{error}</p>}
      <button disabled={disabled || busy || !valid} onClick={check}>
        {text('Проверить выбранные места', 'Таңдалған орындарды тексеру')}
      </button>
      {preview && (
        <div>
          <p>
            {text(
              'Будет сохранён этот порядок без новых схваток:',
              'Жаңа белдесусіз мына рет сақталады:',
            )}
          </p>
          <ol>
            {preview.members.map((id) => (
              <li key={id}>{name(id)}</li>
            ))}
          </ol>
          {preview.blocked && (
            <p role="alert">
              {text(
                'Есть зависимая встреча или автономный журнал, требующие сверки. Решение заблокировано.',
                'Тексеруді қажет ететін тәуелді белдесу немесе автономды журнал бар. Шешім бұғатталды.',
              )}
            </p>
          )}
          <button
            className="solid-button"
            disabled={disabled || busy || !canApprove || preview.blocked}
            onClick={() => onApprove(preview)}
          >
            {text('Утвердить указанный порядок мест', 'Көрсетілген орын ретін бекіту')}
          </button>
        </div>
      )}
    </div>
  );
}
