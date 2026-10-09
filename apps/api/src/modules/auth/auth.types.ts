export type Principal = {
  id: string;
  name: string;
  role: string;
  tatamiId: string | null;
  sessionId: string;
};
export type AuthRequest = {
  headers: Record<string, string | undefined>;
  user: Principal;
  ip?: string;
};
export type CookieResponse = { setHeader: (name: string, value: string) => void };
