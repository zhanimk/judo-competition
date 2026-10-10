import { isRevision, isUuid } from './control-model.ts';
export type InvitationPending =
  | {
      kind: 'CREATE';
      tatamiId: string;
      body: { id: string; expectedRevision: number; label: string; hours: number; token: string };
    }
  | {
      kind: 'REVOKE';
      tatamiId: string;
      invitationId: string;
      body: { id: string; expectedRevision: number; reason: string };
    };
export function restoreInvitationPending(raw: string, tatamiId: string): InvitationPending {
  const p = JSON.parse(raw) as InvitationPending;
  if (p?.tatamiId !== tatamiId || !isUuid(p.body?.id) || !isRevision(p.body?.expectedRevision))
    throw new Error('SAVED_INVITATION_INVALID');
  if (p.kind === 'CREATE') {
    if (
      typeof p.body.label !== 'string' ||
      p.body.label.trim().length < 2 ||
      p.body.label.length > 80 ||
      !Number.isInteger(p.body.hours) ||
      p.body.hours < 1 ||
      p.body.hours > 48 ||
      !/^[a-f\d]{64}$/.test(p.body.token)
    )
      throw new Error('SAVED_INVITATION_INVALID');
  } else if (
    p.kind !== 'REVOKE' ||
    !isUuid(p.invitationId) ||
    typeof p.body.reason !== 'string' ||
    p.body.reason.trim().length < 3 ||
    p.body.reason.length > 500
  )
    throw new Error('SAVED_INVITATION_INVALID');
  return structuredClone(p);
}
export function invitationToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
export function validateInvitationReceipt(pending: InvitationPending, value: unknown) {
  const r = value as {
    id?: string;
    token?: string;
    expiresAt?: string;
    revision?: number;
    ok?: boolean;
  };
  if (!r || !isRevision(r.revision) || r.revision < pending.body.expectedRevision)
    throw new Error('INVALID_INVITATION_RECEIPT');
  if (
    pending.kind === 'CREATE' &&
    (!isUuid(r.id) ||
      r.token !== pending.body.token ||
      typeof r.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(r.expiresAt)))
  )
    throw new Error('INVALID_INVITATION_RECEIPT');
  if (pending.kind === 'REVOKE' && r.ok !== true) throw new Error('INVALID_INVITATION_RECEIPT');
  return r;
}
