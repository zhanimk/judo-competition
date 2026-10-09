import type { Rules } from '@judo/engine/match';
export const demoRules: Rules = {
  durationMs: 240000,
  shidoLimit: 3,
  wazaForIppon: 2,
  enabledScores: ['YUKO', 'WAZA_ARI', 'IPPON'],
  holdThresholds: [
    { ms: 5000, score: 'YUKO' },
    { ms: 10000, score: 'WAZA_ARI' },
    { ms: 20000, score: 'IPPON' },
  ],
};
