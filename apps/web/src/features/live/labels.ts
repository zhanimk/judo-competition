export function resultReasonLabel(reason: string | null | undefined, locale: 'ru' | 'kk') {
  const labels: Record<string, [string, string]> = {
    IPPON: ['Иппон', 'Иппон'],
    COMBINATION: ['Два Waza-ari', 'Екі Waza-ari'],
    TIME: ['Преимущество по оценкам', 'Бағалар бойынша басымдық'],
    ACCUMULATED_SHIDO: ['Три Shido сопернику', 'Қарсыласқа үш Shido'],
    GOLDEN_SCORE: ['Победа в Golden Score', 'Golden Score жеңісі'],
  };
  return reason ? (labels[reason]?.[locale === 'kk' ? 1 : 0] ?? reason) : '—';
}
