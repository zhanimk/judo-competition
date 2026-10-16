'use client';
import { useEffect, useState } from 'react';
import { request } from '../tournaments/api';
import { useLanguage } from '../../shared/i18n/provider';
import type { InformationContent } from '../tournaments/tournament-information';
import { InformationView } from './information-view';
export function PublicInformation({ id }: { id: string }) {
  const { text } = useLanguage();
  const [content, setContent] = useState<InformationContent | null>(null);
  const [loaded, setLoaded] = useState(false),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setError(false);
    setContent(null);
    request<{ information: InformationContent | null }>(`/public/tournaments/${id}/information`)
      .then((value) => {
        if (active) {
          setContent(value.information);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [id, retry]);
  return (
    <section className="panel information-panel">
      {error ? (
        <p role="alert">
          {text('Не удалось загрузить информацию.', 'Ақпаратты жүктеу мүмкін болмады.')}{' '}
          <button onClick={() => setRetry((v) => v + 1)}>{text('Повторить', 'Қайталау')}</button>
        </p>
      ) : !loaded ? (
        <p role="status">{text('Загрузка…', 'Жүктелуде…')}</p>
      ) : content ? (
        <InformationView content={content} />
      ) : (
        <div className="public-info-empty">
          <span className="public-info-empty-icon" aria-hidden="true">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
              <path d="M14 3v6h6M8 13h8M8 17h5" />
            </svg>
          </span>
          <div>
            <h2>{text('Информация готовится', 'Ақпарат дайындалуда')}</h2>
            <p>
              {text(
                'Положение, расписание и адрес появятся здесь после публикации организатором.',
                'Ереже, кесте және мекенжай ұйымдастырушы жариялағаннан кейін осында пайда болады.',
              )}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
