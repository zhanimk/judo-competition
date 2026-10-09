export const labels = { IPPON: 'IPPON', WAZA_ARI: 'WAZA-ARI', YUKO: 'YUKO', SHIDO: 'SHIDO' };
export const russian = { IPPON: 'Иппон', WAZA_ARI: 'Ваза-ари', YUKO: 'Юко', SHIDO: 'Шидо' };
export const statuses = {
  READY: 'Готова к запуску',
  RUNNING: 'Схватка идёт',
  PAUSED: 'Время остановлено',
  DECISION: 'Ожидает решения',
  PROVISIONAL: 'Предварительный результат',
  CONFIRMED: 'Деморезультат подтверждён',
};
export const reasons: Record<string, string> = {
  IPPON: 'Иппон',
  COMBINATION: 'Комбинация оценок',
  TIME: 'Преимущество по оценкам',
  ACCUMULATED_SHIDO: 'Накопление Shido',
  GOLDEN_SCORE: 'Оценка в Golden Score',
};
