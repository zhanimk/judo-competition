export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function request<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const hasBody = data !== undefined;
  const r = await fetch(`/api/v1${path}`, {
    signal: signal ?? AbortSignal.timeout(8000),
    method: hasBody ? 'POST' : 'GET',
    headers: hasBody ? { 'Content-Type': 'application/json', 'X-Judo-Client': 'web' } : undefined,
    body: hasBody ? JSON.stringify(data) : undefined,
    cache: 'no-store',
  });
  let result;
  try {
    result = await r.json();
  } catch {
    if (!r.ok)
      throw new ApiError('Сервер недоступен. Проверьте подключение и повторите.', r.status);
    throw new Error('Сервер недоступен. Проверьте подключение и повторите.');
  }
  if (!r.ok)
    throw new ApiError(
      Array.isArray(result?.message)
        ? result.message.join(' · ')
        : typeof result?.message === 'string' && result.message
          ? result.message
          : 'Не удалось выполнить запрос',
      r.status,
    );
  return result;
}
