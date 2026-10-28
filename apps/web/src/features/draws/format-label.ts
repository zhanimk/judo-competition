export function formatLabel(format: string, locale: string) {
  const labels: Record<string, [string, string]> = {
    SINGLE_ELIMINATION: ['Выбывание без утешения', 'Жұбанышсыз шығару'],
    REPECHAGE: ['Сетка с утешением', 'Жұбаныш торы'],
    ROUND_ROBIN: ['Круговая', 'Айналмалы'],
    MIXED: ['Группы → плей-офф', 'Топтар → плей-офф'],
  };
  return labels[format]?.[locale === 'kk' ? 1 : 0] ?? format;
}
