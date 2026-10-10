import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';

const MAX_FAILURE_KEYS = 10_000;
const NETWORK_FAILURE_LIMIT = 100;
const CREDENTIAL_FAILURE_LIMIT = 10;
const MAX_NETWORK_IN_FLIGHT = 64;
type Channel = 'login' | 'accept';
type Bucket = { count: number; until: number };
const key = (channel: Channel, scope: string, value: string) =>
  createHash('sha256')
    .update(JSON.stringify([channel, scope, value]))
    .digest('hex');

/** Successful venue sign-ins never spend a shared failure budget. Keys contain
 * hashes rather than email addresses, invitation secrets or network addresses. */
export class AuthAttempts {
  private readonly failures = new Map<string, Bucket>();
  private readonly inFlight = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async run<T>(
    channel: Channel,
    credential: string,
    address: string | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const at = this.now();
    for (const [id, bucket] of this.failures) if (bucket.until <= at) this.failures.delete(id);
    const network = key(channel, 'network', address ?? 'unknown');
    const identity = key(channel, 'credential', credential);
    if (
      (this.failures.get(network)?.count ?? 0) >= NETWORK_FAILURE_LIMIT ||
      (this.failures.get(identity)?.count ?? 0) >= CREDENTIAL_FAILURE_LIMIT ||
      (this.inFlight.get(network) ?? 0) >= MAX_NETWORK_IN_FLIGHT ||
      (!this.failures.has(identity) && this.failures.size >= MAX_FAILURE_KEYS)
    )
      throw new HttpException('TRY_LATER', 429);
    this.inFlight.set(network, (this.inFlight.get(network) ?? 0) + 1);
    try {
      const result = await action();
      this.failures.delete(identity);
      return result;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        this.record(network, 5 * 60_000);
        this.record(identity, 15 * 60_000);
      }
      throw error;
    } finally {
      const remaining = (this.inFlight.get(network) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(network, remaining);
      else this.inFlight.delete(network);
    }
  }

  private record(id: string, duration: number) {
    const at = this.now(),
      previous = this.failures.get(id);
    if (!previous && this.failures.size >= MAX_FAILURE_KEYS) return;
    const bucket = previous && previous.until > at ? previous : { count: 0, until: at + duration };
    bucket.count++;
    this.failures.set(id, bucket);
  }
}
