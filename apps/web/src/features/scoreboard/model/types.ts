import type { Command } from '@judo/engine/match';
export type MatchAction = Command extends infer C
  ? C extends Command
    ? Omit<C, 'id' | 'expectedVersion'>
    : never
  : never;
