import { ApiError } from '../tournaments/api.ts';

export const protocolKinds = ['DRAW', 'PARTICIPANTS', 'TEAMS'] as const;
export type ProtocolKind = (typeof protocolKinds)[number];
export type ProtocolArtifact = {
  id: string;
  tournamentId: string;
  version: number;
  kind: ProtocolKind;
  lang: 'ru' | 'kk';
  scope: 'ALL' | 'SELECTED';
  categoryIds: string[];
  sha256: string;
  byteSize: number;
  createdAt: string;
  publishedAt: string | null;
  sourceCurrent: boolean;
  latest?: boolean;
  source: {
    hash: string;
    capturedAt: string;
    rosterRevision: number;
    tournamentName: string;
    categories: { id: string; name: string; drawVersion: number | null }[];
  };
};
export type ProtocolHistory = {
  revision: number;
  tournamentPublished: boolean;
  artifacts: ProtocolArtifact[];
  nextBeforeVersion: number | null;
};
export type PendingProtocol = { tournamentId: string } & (
  | {
      action: 'CREATE';
      body: {
        id: string;
        expectedRevision: number;
        reason: string;
        kind: ProtocolKind;
        lang: 'ru' | 'kk';
        categoryIds?: string[];
      };
    }
  | {
      action: 'PUBLISH' | 'UNPUBLISH';
      artifactId: string;
      artifactSnapshot: ProtocolArtifact;
      body: {
        id: string;
        expectedRevision: number;
        reason: string;
        type: 'PUBLISH' | 'UNPUBLISH';
        sha256: string;
      };
    }
);
export type ProtocolReceipt = { revision: number; artifact: ProtocolArtifact };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export function validProtocolArtifact(value: unknown): value is ProtocolArtifact {
  if (!value || typeof value !== 'object') return false;
  const row = value as ProtocolArtifact;
  return (
    uuid(row.id) &&
    uuid(row.tournamentId) &&
    Number.isSafeInteger(row.version) &&
    row.version > 0 &&
    protocolKinds.includes(row.kind) &&
    ['ru', 'kk'].includes(row.lang) &&
    ['ALL', 'SELECTED'].includes(row.scope) &&
    Array.isArray(row.categoryIds) &&
    row.categoryIds.every(uuid) &&
    new Set(row.categoryIds).size === row.categoryIds.length &&
    hex(row.sha256) &&
    Number.isSafeInteger(row.byteSize) &&
    row.byteSize >= 5 &&
    row.byteSize <= 64 * 1024 * 1024 &&
    date(row.createdAt) &&
    (row.publishedAt === null || date(row.publishedAt)) &&
    typeof row.sourceCurrent === 'boolean' &&
    (row.latest === undefined || typeof row.latest === 'boolean') &&
    !!row.source &&
    hex(row.source.hash) &&
    date(row.source.capturedAt) &&
    Number.isSafeInteger(row.source.rosterRevision) &&
    row.source.rosterRevision >= 0 &&
    typeof row.source.tournamentName === 'string' &&
    Array.isArray(row.source.categories) &&
    row.source.categories.length === row.categoryIds.length &&
    row.source.categories.every(
      (category) =>
        uuid(category.id) &&
        row.categoryIds.includes(category.id) &&
        typeof category.name === 'string' &&
        (category.drawVersion === null || Number.isSafeInteger(category.drawVersion)),
    ) &&
    new Set(row.source.categories.map((category) => category.id)).size === row.categoryIds.length
  );
}
export function validProtocolHistory(
  value: unknown,
  tournamentId: string,
): value is ProtocolHistory {
  if (!value || typeof value !== 'object') return false;
  const history = value as ProtocolHistory;
  return (
    Number.isSafeInteger(history.revision) &&
    history.revision >= 0 &&
    typeof history.tournamentPublished === 'boolean' &&
    Array.isArray(history.artifacts) &&
    history.artifacts.every(
      (artifact) => validProtocolArtifact(artifact) && artifact.tournamentId === tournamentId,
    ) &&
    new Set(history.artifacts.map((artifact) => artifact.id)).size === history.artifacts.length &&
    (history.nextBeforeVersion === null ||
      (Number.isSafeInteger(history.nextBeforeVersion) && history.nextBeforeVersion > 0))
  );
}
function validPending(value: unknown, tournamentId: string): value is PendingProtocol {
  if (!value || typeof value !== 'object') return false;
  const command = value as PendingProtocol,
    body = command.body;
  if (
    Object.keys(command).sort().join(',') !==
    (command.action === 'CREATE'
      ? 'action,body,tournamentId'
      : 'action,artifactId,artifactSnapshot,body,tournamentId')
  )
    return false;
  if (
    command.tournamentId !== tournamentId ||
    !uuid(tournamentId) ||
    !body ||
    !uuid(body.id) ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 0 ||
    typeof body.reason !== 'string' ||
    body.reason.trim().length < 3 ||
    body.reason.length > 500
  )
    return false;
  if (command.action === 'CREATE')
    return (
      Object.keys(body).every((key) =>
        ['id', 'expectedRevision', 'reason', 'kind', 'lang', 'categoryIds'].includes(key),
      ) &&
      protocolKinds.includes(command.body.kind) &&
      ['ru', 'kk'].includes(command.body.lang) &&
      (command.body.categoryIds === undefined ||
        (Array.isArray(command.body.categoryIds) &&
          command.body.categoryIds.length > 0 &&
          command.body.categoryIds.length <= 500 &&
          command.body.categoryIds.every(uuid) &&
          new Set(command.body.categoryIds).size === command.body.categoryIds.length))
    );
  return (
    ['PUBLISH', 'UNPUBLISH'].includes(command.action) &&
    'artifactId' in command &&
    uuid(command.artifactId) &&
    validProtocolArtifact(command.artifactSnapshot) &&
    command.artifactSnapshot.id === command.artifactId &&
    command.artifactSnapshot.tournamentId === tournamentId &&
    Object.keys(body).sort().join(',') === 'expectedRevision,id,reason,sha256,type' &&
    command.body.type === command.action &&
    command.body.sha256 === command.artifactSnapshot.sha256
  );
}
const key = (id: string) => `judo.protocol.pending.${id}`;
export function readPendingProtocol(store: Store, tournamentId: string): PendingProtocol | null {
  const raw = store.getItem(key(tournamentId));
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('PROTOCOL_STORAGE_INVALID');
  }
  if (!validPending(value, tournamentId)) throw new Error('PROTOCOL_STORAGE_INVALID');
  return value;
}
export function savePendingProtocol(store: Store, command: PendingProtocol) {
  if (!validPending(command, command.tournamentId)) throw new Error('PROTOCOL_STORAGE_INVALID');
  const existing = readPendingProtocol(store, command.tournamentId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(command))
    throw new Error('PROTOCOL_PENDING_EXISTS');
  store.setItem(key(command.tournamentId), JSON.stringify(command));
}
export function clearPendingProtocol(store: Store, command: PendingProtocol) {
  const existing = readPendingProtocol(store, command.tournamentId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(command))
    throw new Error('PROTOCOL_PENDING_EXISTS');
  store.removeItem(key(command.tournamentId));
}
export function pendingProtocolJson(store: Store, id: string) {
  if (!readPendingProtocol(store, id)) throw new Error('PROTOCOL_STORAGE_INVALID');
  return store.getItem(key(id))!;
}
export async function deliverProtocol(
  command: PendingProtocol,
  send: (path: string, body: unknown) => Promise<unknown>,
): Promise<
  { kind: 'success'; receipt: ProtocolReceipt } | { kind: 'retry' | 'rejected'; error: unknown }
> {
  try {
    const receipt = (await send(
      `/tournaments/${command.tournamentId}/protocols${command.action === 'CREATE' ? '' : `/${command.artifactId}/command`}`,
      structuredClone(command.body),
    )) as ProtocolReceipt;
    if (
      !Number.isSafeInteger(receipt?.revision) ||
      receipt.revision !== command.body.expectedRevision + 1 ||
      !validProtocolArtifact(receipt.artifact) ||
      receipt.artifact.tournamentId !== command.tournamentId ||
      (command.action === 'CREATE'
        ? receipt.artifact.kind !== command.body.kind ||
          receipt.artifact.lang !== command.body.lang ||
          receipt.artifact.publishedAt !== null ||
          receipt.artifact.scope !== (command.body.categoryIds ? 'SELECTED' : 'ALL') ||
          (command.body.categoryIds &&
            receipt.artifact.categoryIds.some((id) => !command.body.categoryIds!.includes(id)))
        : receipt.artifact.id !== command.artifactId ||
          receipt.artifact.sha256 !== command.body.sha256 ||
          (command.action === 'PUBLISH'
            ? receipt.artifact.publishedAt === null
            : receipt.artifact.publishedAt !== null))
    )
      throw new Error('PROTOCOL_RESPONSE_INVALID');
    return { kind: 'success', receipt };
  } catch (error) {
    return {
      kind:
        error instanceof ApiError &&
        [400, 404, 409].includes(error.status) &&
        error.message !== 'COMMAND_ID_REUSED'
          ? 'rejected'
          : 'retry',
      error,
    };
  }
}
