'use client';
import Link from 'next/link';
import { useLanguage } from '../../shared/i18n/provider';
export function TatamiCards({
  tournamentId,
  tatamis,
}: {
  tournamentId: string;
  tatamis: { id: string; number: number; status?: string }[];
}) {
  const { text } = useLanguage();
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{text('Татами турнира', 'Турнир татамилері')}</h2>
        <Link className="solid-link" href={`/tournaments/${tournamentId}/control`}>
          {text('Центральное управление', 'Орталық басқару')} →
        </Link>
      </div>
      <div className="tournament-grid">
        {tatamis.map((t) => (
          <article className="tournament-card" key={t.id}>
            <span className="draft">
              {t.status === 'BUSY'
                ? text('Схватка на табло', 'Белдесу таблода')
                : text('Нет активной схватки', 'Белсенді белдесу жоқ')}
            </span>
            <h3>Татами {t.number}</h3>
            <p>
              {text(
                'Пульт судьи, экран зрителя и выдача доступа к табло.',
                'Төреші пульті, көрермен экраны және таблоға рұқсат беру.',
              )}
            </p>
            <div className="tatami-card-actions">
              <Link className="solid-link" href={`/operator/${t.id}`}>
                {text('Открыть пульт', 'Пультті ашу')} →
              </Link>
              <Link
                className="outline-link"
                href={`/tournaments/${tournamentId}/tatamis/${t.id}/display`}
              >
                {text('Экран зрителя', 'Көрермен экраны')} ↗
              </Link>
              <Link href={`/tournaments/${tournamentId}/tatamis/${t.id}`}>
                {text('Ссылки и доступ судьи', 'Сілтемелер және төрешіге рұқсат')} →
              </Link>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
