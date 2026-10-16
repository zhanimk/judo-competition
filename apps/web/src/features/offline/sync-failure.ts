import { ApiError } from '../tournaments/api.ts';

/** Temporary congestion/timeouts do not revoke the server's offline ownership. */
export function offlineSyncConflict(error: unknown): string | undefined {
  return error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 429].includes(error.status)
    ? error.message
    : undefined;
}
