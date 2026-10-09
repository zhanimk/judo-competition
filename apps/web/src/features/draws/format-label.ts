export function formatLabel(format: string, locale: string) {
  const labels: Record<string, [string, string]> = {
    SINGLE_ELIMINATION: ['Выбывание без утешения', 'Жұбанышсыз шығару'],
    REPECHAGE: ['Олимпийская с утешением', 'Жұбаныш белдесулері бар олимпиадалық'],
    ROUND_ROBIN: ['Круговая · каждый с каждым', 'Айналмалы · әрқайсысы әрқайсысымен'],
    MIXED: ['Группы → плей-офф', 'Топтар → плей-офф'],
  };
  return labels[format]?.[locale === 'kk' ? 1 : 0] ?? format;
}
