import { ApiError, request } from '../tournaments/api.ts';
export async function logoutSession(send: typeof request = request) {
  try {
    await send('/auth/logout', {});
  } catch (e) {
    // This explicit conflict means the transaction rolled back before logout.
    if (!(e instanceof ApiError) || e.status !== 409 || e.message !== 'ACCESS_CHANGED_RETRY')
      throw e;
    await send('/auth/logout', {});
  }
}
