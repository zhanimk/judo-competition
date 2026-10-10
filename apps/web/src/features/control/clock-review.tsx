import { MAX_CORRECTED_GOLDEN_MS, type MatchState } from '@judo/engine/match';
import { useLanguage } from '../../shared/i18n/provider';
import { clockEditValue, formatClockTenths, previewClockCorrection } from './clock-edit';

export function ClockCorrectionReview({
  state,
  value,
  disabled,
  white,
  blue,
  onChange,
}: {
  state: MatchState | null;
  value: string;
  disabled: boolean;
  white: string;
  blue: string;
  onChange: (value: string) => void;
}) {
  const { text } = useLanguage();
  let preview: ReturnType<typeof previewClockCorrection> | null = null;
  let error = '';
  if (state) {
    try {
      preview = previewClockCorrection(state, value);
    } catch (problem) {
      const code = (problem as Error).message;
      error =
        code === 'CLOCK_INPUT_FORMAT'
          ? text(
              'Введите время в формате 02:35.4 (минуты:секунды.десятые).',
              'Уақытты 02:35.4 пішімінде енгізіңіз (минут:секунд.ондық).',
            )
          : code === 'INVALID_TIME'
            ? text('Время выходит за допустимый диапазон.', 'Уақыт рұқсат етілген аралықтан тыс.')
            : text(
                'Коррекция доступна на паузе или для предварительной победы по времени, без удержания. Остановите встречу в пульте и заново откройте проверку.',
                'Түзету үзілісте немесе уақыт бойынша алдын ала жеңіс кезінде, ұстап тұрусыз қолжетімді. Пультте белдесуді тоқтатып, тексеруді қайта ашыңыз.',
              );
    }
  }
  return (
    <fieldset className="control-clock-review" disabled={disabled}>
      <legend>{text('Коррекция остановленного времени', 'Тоқтатылған уақытты түзету')}</legend>
      {!state ? (
        <p className="error-box">
          {text(
            'Нет актуального состояния встречи. Обновите данные и заново откройте проверку.',
            'Белдесудің өзекті күйі жоқ. Деректерді жаңартып, тексеруді қайта ашыңыз.',
          )}
        </p>
      ) : (
        <>
          <p>
            {state.phase === 'REGULAR' ? text('Основное время', 'Негізгі уақыт') : 'Golden Score'} ·{' '}
            {text('Сейчас', 'Қазір')}: <strong>{clockEditValue(state)}</strong>
          </p>
          <label>
            {state.phase === 'REGULAR'
              ? text('Оставшееся время', 'Қалған уақыт')
              : text('Прошедшее время Golden Score', 'Golden Score өткен уақыты')}
            <input
              className="control-time-input"
              value={value}
              maxLength={8}
              autoComplete="off"
              spellCheck={false}
              placeholder="02:35.4"
              onChange={(event) => onChange(event.target.value)}
              aria-describedby="clock-edit-range"
            />
          </label>
          <p className="field-note" id="clock-edit-range">
            {text('Формат', 'Пішім')}: mm:ss.t · {text('Диапазон', 'Аралық')}: 00:00.0–
            {formatClockTenths(
              state.phase === 'REGULAR' ? state.rules.durationMs : MAX_CORRECTED_GOLDEN_MS,
            )}
          </p>
          {error && (
            <p className="error-box" role="status">
              {error}
            </p>
          )}
          {preview && (
            <div className="control-clock-preview" role="status">
              <strong>
                {text('После сохранения', 'Сақталғаннан кейін')}: {clockEditValue(preview.state)}
              </strong>
              <p>
                {preview.state.outcome
                  ? text(
                      'Основное время истечёт. Победа по времени: ',
                      'Негізгі уақыт аяқталады. Уақыт бойынша жеңіс: ',
                    ) +
                    (preview.state.outcome.winner === 'WHITE' ? white : blue) +
                    text(
                      '. Результат потребуется подтвердить в пульте.',
                      '. Нәтижені пультте растау қажет.',
                    )
                  : preview.state.status === 'DECISION'
                    ? text(
                        'Основное время истечёт при равном счёте. В пульте потребуется решение о продолжении.',
                        'Негізгі уақыт тең есеппен аяқталады. Жалғастыру шешімін пультте қабылдау қажет.',
                      )
                    : state.outcome?.reason === 'TIME'
                      ? text(
                          'Предварительная победа по времени будет снята. Оценки сохранятся, встреча останется на паузе. Продолжение запускается отдельно в пульте.',
                          'Уақыт бойынша алдын ала жеңіс қайтарылады. Бағалар сақталып, белдесу үзілісте қалады. Жалғастыру пультте бөлек іске қосылады.',
                        )
                      : text(
                          'Встреча останется на паузе. Продолжение запускается отдельно в пульте.',
                          'Белдесу үзілісте қалады. Жалғастыру пультте бөлек іске қосылады.',
                        )}
              </p>
            </div>
          )}
        </>
      )}
      <p>
        {text(
          'Фаза и оценки сохраняются. Перед продолжением проверьте новое время в пульте.',
          'Кезең мен бағалар сақталады. Жалғастырмас бұрын пульттегі жаңа уақытты тексеріңіз.',
        )}
      </p>
    </fieldset>
  );
}
