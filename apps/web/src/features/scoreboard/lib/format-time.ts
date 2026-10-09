export function time(ms: number) {
  const t = Math.floor(Math.max(0, ms) / 100);
  return {
    main: `${Math.floor(t / 600)}:${String(Math.floor(t / 10) % 60).padStart(2, '0')}`,
    tenth: t % 10,
  };
}
