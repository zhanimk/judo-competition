import type { View } from './live-board';

/** Refresh display names without changing the immutable offline sporting snapshot. */
export function refreshParticipantNames(saved: View, live: View | null): View {
  const original = saved.currentMatch;
  const current = live?.currentMatch;
  if (
    saved.tournamentId !== live?.tournamentId ||
    !original ||
    !current ||
    !original.white ||
    !original.blue ||
    !current.white ||
    !current.blue ||
    original.id !== current.id ||
    original.white?.id !== current.white?.id ||
    original.blue?.id !== current.blue?.id
  )
    return saved;
  return {
    ...saved,
    currentMatch: {
      ...original,
      white: {
        ...original.white,
        firstName: current.white.firstName,
        lastName: current.white.lastName,
      },
      blue: {
        ...original.blue,
        firstName: current.blue.firstName,
        lastName: current.blue.lastName,
      },
    },
  };
}
