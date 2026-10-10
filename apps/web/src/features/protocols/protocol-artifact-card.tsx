'use client';
import type { ReactNode } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import type { ProtocolArtifact } from './protocol-model';
import { protocolLabels } from './protocol-labels';

export function ProtocolArtifactCard({
  artifact,
  guest = false,
  children,
}: {
  artifact: ProtocolArtifact;
  guest?: boolean;
  children?: ReactNode;
}) {
  const { text, locale } = useLanguage();
  const [ru, kk] = protocolLabels[artifact.kind];
  return (
    <article className="protocol-artifact">
      <div className="protocol-artifact-title">
        <h3>
          {text(ru, kk)} · {artifact.lang.toUpperCase()}
        </h3>
        <span>
          {text('Версия', 'Нұсқа')} {artifact.version}
          {artifact.latest ? ` · ${text('последняя', 'соңғы')}` : ''}
        </span>
      </div>
      <p>
        {artifact.scope === 'ALL'
          ? text('Все категории на момент создания', 'Жасалған кездегі барлық санаттар')
          : text('Выбранные категории', 'Таңдалған санаттар')}
        : {artifact.source.categories.map((category) => category.name).join(', ') || '—'}
      </p>
      <p className="protocol-artifact-date">
        {text('Создано', 'Жасалған')}:{' '}
        {new Date(artifact.createdAt).toLocaleString(locale === 'kk' ? 'kk-KZ' : 'ru-RU')} ·{' '}
        {Math.ceil(artifact.byteSize / 1024)} KB
      </p>
      <p className={artifact.sourceCurrent ? 'protocol-current' : 'protocol-archive'} role="status">
        {!artifact.sourceCurrent
          ? text(
              'Архивная версия: данные документа изменились, включая возможные изменения имён, состава или результатов. Файл сохраняет исходный снимок.',
              'Мұрағаттық нұсқа: құжат деректері өзгерген, оның ішінде есімдер, құрам немесе нәтижелер өзгеруі мүмкін. Файл бастапқы деректерді сақтайды.',
            )
          : text('Соответствует текущим данным документа.', 'Құжаттың қазіргі деректеріне сәйкес.')}
      </p>
      {!guest && (
        <p>
          {artifact.publishedAt
            ? text('Опубликовано для зрителей', 'Көрермендерге жарияланған')
            : text('Не опубликовано', 'Жарияланбаған')}
        </p>
      )}
      <div className="protocol-artifact-actions">
        <a
          className="solid-link"
          href={`/api/v1${guest ? '/public' : ''}/tournaments/${artifact.tournamentId}/protocols/${artifact.id}.pdf`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {guest
            ? text('Скачать PDF', 'PDF жүктеу')
            : text('Открыть PDF для проверки', 'Тексеру үшін PDF ашу')}
        </a>
        {children}
      </div>
      <details className="protocol-checksum">
        <summary>{text('Контрольная сумма SHA-256', 'SHA-256 бақылау сомасы')}</summary>
        <code>{artifact.sha256}</code>
      </details>
    </article>
  );
}
