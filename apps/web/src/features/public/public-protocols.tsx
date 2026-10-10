'use client';
import { useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { ProtocolArtifactCard } from '../protocols/protocol-artifact-card';
import { useProtocolHistory } from '../protocols/use-protocol-history';
import '../protocols/protocol-publications.css';

export function PublicProtocols({ tournamentId }: { tournamentId: string }) {
  const { text } = useLanguage();
  const [beforeVersion, setBeforeVersion] = useState<number | undefined>();
  const { history, error, refresh } = useProtocolHistory(tournamentId, true, beforeVersion);
  return (
    <section className="spectator-section protocol-publications">
      <div className="protocol-heading">
        <h2>{text('Опубликованные PDF', 'Жарияланған PDF')}</h2>
      </div>
      <p>
        {text(
          'Документы проверяет и публикует администратор. Каждый файл сохраняет данные на момент создания. Если имена или результаты изменились, старая версия отмечена как архивная.',
          'Құжаттарды әкімші тексеріп, жариялайды. Әр файл жасалған кездегі деректерді сақтайды. Есімдер немесе нәтижелер өзгерсе, бұрынғы нұсқа мұрағаттық деп белгіленеді.',
        )}
      </p>
      {error && (
        <p className="error-box" role="alert">
          {history
            ? text(
                'Связь потеряна. Список может быть устаревшим; доступ к каждому файлу проверяется при скачивании.',
                'Байланыс үзілді. Тізім ескірген болуы мүмкін; әр файлға қолжетімділік жүктеу кезінде тексеріледі.',
              )
            : text(
                'Опубликованные документы недоступны.',
                'Жарияланған құжаттар қолжетімсіз.',
              )}{' '}
          <button
            onClick={() => {
              void refresh().catch(() => {});
            }}
          >
            {text('Повторить', 'Қайталау')}
          </button>
        </p>
      )}
      {!history && !error && (
        <p role="status">{text('Загружаем документы…', 'Құжаттар жүктелуде…')}</p>
      )}
      {history && !history.artifacts.length && (
        <p className="state-box">
          {text('Администратор ещё не опубликовал PDF.', 'Әкімші PDF әлі жариялаған жоқ.')}
        </p>
      )}
      <div className="protocol-artifacts">
        {history?.artifacts.map((artifact) => (
          <ProtocolArtifactCard key={artifact.id} artifact={artifact} guest />
        ))}
      </div>
      <div className="protocol-artifact-actions">
        {beforeVersion && (
          <button onClick={() => setBeforeVersion(undefined)}>
            {text('Последние версии', 'Соңғы нұсқалар')}
          </button>
        )}
        {history?.nextBeforeVersion && (
          <button disabled={!!error} onClick={() => setBeforeVersion(history.nextBeforeVersion!)}>
            {text('Более ранние версии', 'Бұрынғы нұсқалар')}
          </button>
        )}
      </div>
    </section>
  );
}
