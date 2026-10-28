'use client';
import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import {
  emptyInformation,
  readRegulationImage,
  type InformationContent,
  type InformationState,
} from './tournament-information';
import { InformationView } from '../public/information-view';
import { useLanguage } from '../../shared/i18n/provider';

export function TournamentInformationEditor({
  id,
  saveVersion,
  blocked,
  tournamentPublished,
  onSave,
}: {
  id: string;
  saveVersion: number;
  blocked: boolean;
  tournamentPublished: boolean;
  onSave: (
    data: { expectedRevision: number; action: string } & InformationContent,
  ) => Promise<void>;
}) {
  const { text } = useLanguage();
  const [content, setContent] = useState<InformationContent>({ ...emptyInformation });
  const [loaded, setLoaded] = useState(false),
    [error, setError] = useState(''),
    [published, setPublished] = useState(false);
  const [imageBusy, setImageBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [retry, setRetry] = useState(0);
  const baseRevision = useRef(0);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setError('');
    request<InformationState>(`/tournaments/${id}/information`)
      .then((value) => {
        if (active) {
          setContent(value.draft);
          setDirty(false);
          setPublished(!!value.published);
          baseRevision.current = value.administrationRevision;
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      });
    return () => {
      active = false;
    };
  }, [id, retry, saveVersion]);
  function change(key: keyof InformationContent, value: string) {
    setContent((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }
  async function save(action: string) {
    setSaving(true);
    try {
      await onSave({ ...content, action, expectedRevision: baseRevision.current });
    } finally {
      setSaving(false);
    }
  }
  const disabled = blocked || imageBusy || saving || !loaded;
  return (
    <section className="panel information-panel">
      <h2>{text('Описание турнира', 'Турнир сипаттамасы')}</h2>
      <p>
        {text(
          'Зрители видят только опубликованную версию.',
          'Көрермендер тек жарияланған нұсқаны көреді.',
        )}
      </p>
      <p>
        {published
          ? text('Информация опубликована', 'Ақпарат жарияланған')
          : text('Информация не опубликована', 'Ақпарат жарияланбаған')}
      </p>
      {error && (
        <p role="alert" className="error-box">
          {error}{' '}
          <button onClick={() => setRetry((v) => v + 1)}>
            {text('Загрузить заново', 'Қайта жүктеу')}
          </button>
        </p>
      )}
      {!loaded ? (
        <p role="status">{text('Загрузка…', 'Жүктелуде…')}</p>
      ) : (
        <div className="information-editor">
          <label>
            {text('Информация по регламенту', 'Регламент бойынша ақпарат')}
            <textarea
              maxLength={5000}
              disabled={disabled}
              value={content.description}
              onChange={(e) => change('description', e.target.value)}
              placeholder={text(
                'Программа, время начала, условия участия, контакты организатора…',
                'Бағдарлама, басталу уақыты, қатысу шарттары, ұйымдастырушы байланысы…',
              )}
            />
          </label>
          <label>
            {text('Взвешивание: дата, время и место', 'Салмақ өлшеу: күні, уақыты және орны')}
            <textarea
              maxLength={2000}
              disabled={disabled}
              value={content.weighing}
              onChange={(e) => change('weighing', e.target.value)}
            />
          </label>
          <label>
            {text('Адрес проведения турнира', 'Турнир өтетін мекенжай')}
            <textarea
              maxLength={500}
              disabled={disabled}
              value={content.address}
              onChange={(e) => change('address', e.target.value)}
            />
          </label>
          <label>
            {text(
              'Ссылка на карту (2ГИС, Яндекс, Google Maps)',
              'Карта сілтемесі (2ГИС, Яндекс, Google Maps)',
            )}
            <input
              type="url"
              maxLength={2000}
              disabled={disabled}
              value={content.mapUrl}
              onChange={(e) => change('mapUrl', e.target.value)}
              placeholder="https://…"
            />
          </label>
          <label>
            {text('Изображение положения (JPEG, PNG, WebP)', 'Ереже суреті (JPEG, PNG, WebP)')}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={disabled}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setImageBusy(true);
                setError('');
                try {
                  change('imageData', await readRegulationImage(file));
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setImageBusy(false);
                }
              }}
            />
          </label>
          <p>
            {text(
              'Изображение автоматически уменьшается для публикации. Проверьте читаемость в предпросмотре.',
              'Сурет жариялау үшін автоматты кішірейтіледі. Алдын ала қарауда оқылуын тексеріңіз.',
            )}
          </p>
          {content.imageData && (
            <button disabled={disabled} onClick={() => change('imageData', '')}>
              {text('Убрать изображение из черновика', 'Жобадан суретті алып тастау')}
            </button>
          )}
          <details open>
            <summary>{text('Предпросмотр', 'Алдын ала қарау')}</summary>
            <InformationView content={content} />
          </details>
          {!tournamentPublished && (
            <p>
              {text(
                'Для публикации информации сначала опубликуйте сам турнир.',
                'Ақпаратты жариялау үшін алдымен турнирді жариялаңыз.',
              )}
            </p>
          )}
          <div className="information-actions">
            <button
              disabled={disabled}
              onClick={() => {
                if (
                  window.confirm(
                    text(
                      'Загрузить сохранённый черновик? Несохранённые изменения будут потеряны.',
                      'Сақталған жобаны жүктеу керек пе? Сақталмаған өзгерістер жоғалады.',
                    ),
                  )
                )
                  setRetry((v) => v + 1);
              }}
            >
              {text('Загрузить сохранённый черновик', 'Сақталған жобаны жүктеу')}
            </button>
            <button disabled={disabled} onClick={() => save('SAVE')}>
              {text('Сохранить черновик', 'Жобаны сақтау')}
            </button>
            <button disabled={disabled || !tournamentPublished} onClick={() => save('PUBLISH')}>
              {text('Опубликовать информацию', 'Ақпаратты жариялау')}
            </button>
            {published && (
              <button disabled={disabled} onClick={() => save('HIDE')}>
                {text('Скрыть опубликованную информацию', 'Жарияланған ақпаратты жасыру')}
              </button>
            )}
          </div>
          {saveVersion > 0 && !dirty && <p role="status">{text('Сохранено', 'Сақталды')}</p>}
        </div>
      )}
    </section>
  );
}
