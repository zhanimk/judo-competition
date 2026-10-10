import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { drawFormat, type Draw } from '@judo/engine/draw';
import type { ProtocolTournament } from './protocol-model.js';
import type { PublishedProtocolKind } from './protocol-publication.dto.js';

export const MAX_PROTOCOL_BYTES = 64 * 1024 * 1024;
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}
export const protocolHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Fingerprint document inputs, excluding access/session data and sporting receipts. */
export function protocolSourceHash(t: ProtocolTournament, kind: PublishedProtocolKind): string {
  const source = {
    name: t.name,
    city: t.city,
    venue: t.venue,
    startDate: t.startDate,
    endDate: t.endDate,
    rulesSnapshot: t.rulesSnapshot,
    categories: t.categories.map((category) => ({
      id: category.id,
      name: category.name,
      gender: category.gender,
      birthYearFrom: category.birthYearFrom,
      birthYearTo: category.birthYearTo,
      minWeightGrams: category.minWeightGrams,
      maxWeightGrams: category.maxWeightGrams,
      durationSeconds: category.durationSeconds,
      format: category.draw
        ? drawFormat(category.draw.snapshot as unknown as Draw)
        : category.format,
      entries: category.entries.map(({ id, firstName, lastName, birthYear, club }) => ({
        id,
        firstName,
        lastName,
        birthYear,
        club,
      })),
      draw: category.draw && {
        version: category.draw.version,
        status: category.draw.status,
        publishedAt: category.draw.publishedAt,
        ...(kind === 'PARTICIPANTS'
          ? {}
          : {
              snapshot: category.draw.snapshot,
              contests: category.draw.contests.map(
                ({
                  id,
                  key,
                  round,
                  status,
                  whiteEntryId,
                  blueEntryId,
                  winnerEntryId,
                  resultReason,
                  state,
                  offlineSessionId,
                  offlineActorId,
                  offlineControlGeneration,
                }) => ({
                  id,
                  key,
                  round,
                  status,
                  whiteEntryId,
                  blueEntryId,
                  winnerEntryId,
                  resultReason,
                  offline:
                    offlineSessionId != null ||
                    offlineActorId != null ||
                    offlineControlGeneration != null,
                  state:
                    status !== 'CONFIRMED'
                      ? null
                      : state && typeof state === 'object' && !Array.isArray(state)
                        ? { ...state, receipts: {} }
                        : state,
                }),
              ),
            }),
      },
    })),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(source)))
    .digest('hex');
}

export function verifiedProtocolBytes(bytes: Uint8Array, byteSize: number, sha256: string): Buffer {
  const buffer = Buffer.from(bytes);
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize < 5 ||
    byteSize > MAX_PROTOCOL_BYTES ||
    buffer.length !== byteSize ||
    !/^[a-f0-9]{64}$/.test(sha256) ||
    buffer.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    protocolHash(buffer) !== sha256
  )
    throw new ConflictException('PROTOCOL_ARTIFACT_INVALID');
  return buffer;
}
