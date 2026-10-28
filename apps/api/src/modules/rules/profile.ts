import type { Rules } from '@judo/engine/match';
export type Profile = Omit<Rules, 'durationMs'> & {
  version: string;
  drawPolicy?: 'REPECHAGE_ONLY' | 'KNOCKOUT_FROM_SIX' | 'TWO_FORMATS';
  official: false;
  tieBreak: 'PUBLISHED_LOT' | 'REMATCH';
  tieRanking?: 'WINS_ONLY';
  tieMany?: 'ADMIN_REVIEW';
  roundRobinMedals?: 'TWO_BRONZE_FOR_FOUR_FIVE';
  restMs: number;
  categories?: Record<string, { durationSeconds: number; format: string; resolvedFormat?: string }>;
  approvedAt?: string;
};
export const legacyProfile = (): Profile => ({
  version: 'custom-2026-v3',
  drawPolicy: 'REPECHAGE_ONLY',
  official: false,
  tieBreak: 'REMATCH',
  restMs: 600000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [
    { ms: 5000, score: 'YUKO' },
    { ms: 10000, score: 'WAZA_ARI' },
    { ms: 20000, score: 'IPPON' },
  ],
});
export const currentProfile = (): Profile => ({
  ...legacyProfile(),
  version: 'custom-2026-v7',
  drawPolicy: 'TWO_FORMATS',
  roundRobinMedals: 'TWO_BRONZE_FOR_FOUR_FIVE',
  tieRanking: 'WINS_ONLY',
  tieMany: 'ADMIN_REVIEW',
});
// A missing historical snapshot must never silently acquire newer sporting rules.
export const profile = (value: unknown): Profile => (value as Profile) ?? legacyProfile();
export function matchRules(value: unknown, categoryId: string, durationSeconds: number): Rules {
  const p = profile(value);
  return {
    durationMs: (p.categories?.[categoryId]?.durationSeconds ?? durationSeconds) * 1000,
    shidoLimit: p.shidoLimit,
    wazaForIppon: p.wazaForIppon,
    enabledScores: p.enabledScores,
    holdThresholds: p.holdThresholds,
  };
}
