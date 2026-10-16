'use client';
import { useLanguage } from '../../shared/i18n/provider';
import type { InformationContent } from '../tournaments/tournament-information';
import './information.css';

export function InformationView({ content }: { content: InformationContent }) {
  const { text } = useLanguage();
  let mapUrl = '';
  try {
    const url = new URL(content.mapUrl);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
      mapUrl = url.href;
  } catch {
    /* An incomplete draft link has no clickable preview. */
  }
  return (
    <div className="tournament-information">
      {content.description && (
        <section>
          <h2>{text('Информация о турнире', 'Турнир туралы ақпарат')}</h2>
          <p className="information-text">{content.description}</p>
        </section>
      )}
      {content.weighing && (
        <section>
          <h2>{text('Взвешивание', 'Салмақ өлшеу')}</h2>
          <p className="information-text">{content.weighing}</p>
        </section>
      )}
      {(content.address || content.mapUrl) && (
        <section>
          <h2>{text('Место проведения', 'Өтетін орны')}</h2>
          {content.address && <p className="information-text">{content.address}</p>}
          {mapUrl && (
            <a href={mapUrl} target="_blank" rel="noopener noreferrer">
              {text('Открыть на карте ↗', 'Картадан ашу ↗')}
            </a>
          )}
        </section>
      )}
      {content.imageData && (
        <section>
          <h2>{text('Положение о соревновании', 'Жарыс ережесі')}</h2>
          <a className="information-image-link" href={content.imageData} download="regulation.jpg">
            {text('Скачать изображение положения', 'Ереже суретін жүктеу')}
          </a>
          {/* A local, validated raster data URL needs no remote image service. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="information-image"
            src={content.imageData}
            alt={text('Положение о соревновании', 'Жарыс ережесі')}
          />
        </section>
      )}
      {!Object.values(content).some(Boolean) && (
        <p>{text('Информация пока не добавлена.', 'Ақпарат әлі қосылмаған.')}</p>
      )}
    </div>
  );
}
