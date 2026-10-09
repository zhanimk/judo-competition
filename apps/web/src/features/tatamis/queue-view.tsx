'use client';
import { useLanguage } from '../../shared/i18n/provider';
export type QueueItem = {
  round?: number;
  blockedByRound?: boolean;
  id: string;
  key: string;
  category: string;
  white: { firstName: string; lastName: string; club: string } | null;
  blue: { firstName: string; lastName: string; club: string } | null;
};
export function QueueView({ items }: { items: QueueItem[] }) {
  const { text } = useLanguage();
  return (
    <section className="panel" style={{ marginTop: 24 }}>
      <div className="panel-heading">
        <h2>{text('Очередь схваток', 'Белдесулер кезегі')}</h2>
        <span>{items.length}</span>
      </div>
      {items.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>№</th>
                <th>{text('Категория', 'Санат')}</th>
                <th>{text('Белый', 'Ақ')}</th>
                <th>{text('Синий', 'Көк')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m, i) => (
                <tr key={m.id}>
                  <td>
                    {i + 1} · {m.key}
                    <small>
                      {text('Круг', 'Айналым')} {m.round ?? '—'}
                      {m.blockedByRound
                        ? ' · ' + text('после предыдущего круга', 'алдыңғы айналымнан кейін')
                        : ''}
                    </small>
                  </td>
                  <td>{m.category}</td>
                  <td>
                    {m.white?.lastName} {m.white?.firstName}
                    <small>{m.white?.club}</small>
                  </td>
                  <td>
                    {m.blue?.lastName} {m.blue?.firstName}
                    <small>{m.blue?.club}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="state-box">
          {text('Назначенных схваток пока нет.', 'Тағайындалған белдесулер әлі жоқ.')}
        </p>
      )}
    </section>
  );
}
