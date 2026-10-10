import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyControlReceipt,
  controlGrant,
  restoreControlPending,
  retainUncertainCommand,
  sameGrant,
  type ControlContext,
} from '../src/features/auth/control-model.ts';
import { acquireTabDevice } from '../src/features/auth/tab-device.ts';
import { restoreMatchPending } from '../src/features/live/pending-command.ts';
import {
  restoreInvitationPending,
  validateInvitationReceipt,
  type InvitationPending,
} from '../src/features/auth/invitation-model.ts';
import { journalControlError, type Journal } from '../src/features/offline/journal.ts';
import { createMatch } from '@judo/engine/match';
import { logoutSession } from '../src/features/auth/logout.ts';
import { ApiError } from '../src/features/tournaments/api.ts';
const mat = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const command = '44444444-4444-4444-8444-444444444444';
const context = (): ControlContext => ({
  tatamiId: mat,
  tournamentId: mat,
  number: 1,
  tournamentName: 'Тест',
  operatorName: 'Судья',
  role: 'OPERATOR',
  workRole: 'JUDGE',
  matchCommandsAvailable: true,
  accessRevision: 8,
  control: {
    generation: 4,
    held: true,
    owned: true,
    holderName: 'Судья',
    holderValid: true,
    acquiredAt: '2026-10-09T00:00:00Z',
  },
  queue: [],
});
test('only a valid holder in this tab receives a grant; an expired holder still occupies the control', () => {
  assert.deepEqual(controlGrant(context(), device), { deviceId: device, controlGeneration: 4 });
  for (const changed of [{ held: false, owned: false }, { owned: false }, { holderValid: false }]) {
    assert.equal(
      controlGrant({ ...context(), control: { ...context().control, ...changed } }, device),
      null,
    );
  }
  assert.equal(controlGrant(context(), null), null);
});
test('a historical claim receipt cannot overwrite a newer takeover or release snapshot', () => {
  const current = context();
  const old = { revision: 7, control: { ...current.control, generation: 3 } };
  assert.equal(applyControlReceipt(current, old), current);
  assert.equal(
    applyControlReceipt(current, {
      revision: 9,
      control: { ...current.control, generation: 5, held: false, owned: false },
    })?.accessRevision,
    9,
  );
  assert.throws(
    () =>
      applyControlReceipt(current, {
        revision: 9,
        control: { ...current.control, generation: -1 },
      }),
    /INVALID_CONTROL_RECEIPT/,
  );
});
test('lost control commands restore their original ID, device, revision and takeover reason', () => {
  const value = {
    tatamiId: mat,
    command: {
      id: command,
      expectedRevision: 8,
      deviceId: device,
      type: 'TAKEOVER',
      reason: 'Замена устройства',
    },
  };
  const raw = JSON.stringify(value),
    saved = restoreControlPending(raw, mat);
  assert.deepEqual(saved, value);
  saved.command.reason = 'Другая причина';
  assert.equal(restoreControlPending(raw, mat).command.reason, 'Замена устройства');
  assert.throws(() => restoreControlPending(raw, other), /SAVED_CONTROL_INVALID/);
  assert.throws(
    () =>
      restoreControlPending(
        JSON.stringify({ ...value, command: { ...value.command, reason: '' } }),
        mat,
      ),
    /SAVED_CONTROL_INVALID/,
  );
});
test('uncertain responses and access loss retain evidence while a known version rejection is final', () => {
  for (const [status, code] of [
    [undefined, 'Network'],
    [503, 'Down'],
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [409, 'CONTROL_GENERATION_STALE'],
  ] as const)
    assert.equal(retainUncertainCommand(status, code), true);
  assert.equal(retainUncertainCommand(409, 'ACCESS_VERSION_CONFLICT'), false);
  assert.equal(retainUncertainCommand(409, 'CONTROL_HELD'), false);
});
test('a copied tab receives a new device ID rather than sharing the first tab lock', async () => {
  const values = new Map([['judo.tab-device.v1', device]]),
    requested: string[] = [];
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const locks = {
    request: async (
      name: string,
      _options: { ifAvailable: true },
      callback: (lock: unknown) => Promise<void>,
    ) => {
      requested.push(name);
      void callback(name.endsWith(device) ? null : {});
    },
  };
  const acquired = await acquireTabDevice(storage, locks, () => other);
  assert.deepEqual(acquired, { id: other, duplicated: true });
  assert.deepEqual(requested, ['judo-tab-device:' + device, 'judo-tab-device:' + other]);
  assert.equal(values.get('judo.tab-device.v1'), other);
});
test('a reload reuses its persisted free device and storage failure never grants control', async () => {
  const storage = { getItem: () => device, setItem: () => {} };
  const locks = {
    request: async (
      _name: string,
      _options: { ifAvailable: true },
      callback: (lock: unknown) => Promise<void>,
    ) => {
      void callback({});
    },
  };
  assert.deepEqual(await acquireTabDevice(storage, locks, () => other), {
    id: device,
    duplicated: false,
  });
  await assert.rejects(
    acquireTabDevice(
      {
        ...storage,
        setItem: () => {
          throw new Error('storage');
        },
      },
      locks,
      () => other,
    ),
    /storage/,
  );
});
test('sport retry keeps the original generation and cannot be rebound to a takeover grant', () => {
  const raw = JSON.stringify({
    contestId: mat,
    payload: {
      id: command,
      expectedVersion: 12,
      type: 'STOP',
      deviceId: device,
      controlGeneration: 4,
    },
  });
  const saved = restoreMatchPending(raw);
  assert.equal(sameGrant(saved.payload, { deviceId: device, controlGeneration: 5 }), false);
  assert.equal(sameGrant(saved.payload, { deviceId: other, controlGeneration: 4 }), false);
  assert.equal(saved.payload.controlGeneration, 4);
  assert.equal(saved.payload.id, command);
  const legacy = JSON.parse(raw);
  delete legacy.payload.controlGeneration;
  assert.throws(() => restoreMatchPending(JSON.stringify(legacy)), /LEGACY_CONTROL_METADATA/);
});
const invitation = (): InvitationPending => ({
  kind: 'CREATE',
  tatamiId: mat,
  body: { id: command, expectedRevision: 8, label: 'Судья 1', hours: 8, token: 'a'.repeat(64) },
});
test('invitation receipt uses a separate server invitation ID while exact retry keeps the command ID and secret', () => {
  const saved = restoreInvitationPending(JSON.stringify(invitation()), mat);
  assert.deepEqual(saved, invitation());
  const receipt = {
    id: other,
    token: 'a'.repeat(64),
    expiresAt: '2026-10-10T00:00:00Z',
    revision: 9,
  };
  assert.equal(validateInvitationReceipt(saved, receipt), receipt);
  assert.notEqual(receipt.id, saved.body.id, 'the access command is separate from the invitation');
  assert.equal(saved.body.id, command);
  assert.equal(
    validateInvitationReceipt(restoreInvitationPending(JSON.stringify(saved), mat), receipt).id,
    other,
  );
  for (const changed of [
    { id: 'invalid-invitation-id' },
    { token: 'b'.repeat(64) },
    { revision: 7 },
  ])
    assert.throws(
      () => validateInvitationReceipt(saved, { ...receipt, ...changed }),
      /INVALID_INVITATION_RECEIPT/,
    );
});
test('saved revocation includes a concrete target and reason; corrupt saved access is not silently replaced', () => {
  const revoke: InvitationPending = {
    kind: 'REVOKE',
    tatamiId: mat,
    invitationId: other,
    body: { id: command, expectedRevision: 8, reason: 'Замена судьи' },
  };
  assert.deepEqual(restoreInvitationPending(JSON.stringify(revoke), mat), revoke);
  assert.throws(
    () => restoreInvitationPending(JSON.stringify({ ...revoke, invitationId: 'unknown' }), mat),
    /SAVED_INVITATION_INVALID/,
  );
  assert.throws(() => restoreInvitationPending('{broken', mat));
});
const journal = (): Journal => ({
  sessionId: command,
  view: {
    tournamentId: mat,
    tournamentName: 'Тест',
    tournamentStatus: 'RUNNING',
    number: 1,
    currentMatch: null,
    lastResult: null,
  },
  state: createMatch({
    durationMs: 60000,
    shidoLimit: 3,
    wazaForIppon: 2,
    enabledScores: ['IPPON'],
    holdThresholds: [],
  }),
  revision: 2,
  events: [],
  opening: false,
  grant: { deviceId: device, controlGeneration: 4 },
});
test('legacy autonomous journals remain unchanged and require export and review, without guessing grants', () => {
  const saved = journal();
  delete saved.grant;
  const original = structuredClone(saved);
  assert.equal(
    journalControlError(saved, { deviceId: device, controlGeneration: 4 }, true, device),
    'LEGACY_CONTROL_METADATA',
  );
  assert.deepEqual(saved, original);
});
test('autonomous work survives network loss but stops after known takeover or a copied-tab device', () => {
  const saved = journal();
  assert.equal(journalControlError(saved, null, false, device), null);
  assert.equal(journalControlError(saved, null, true, device), 'CONTROL_GENERATION_STALE');
  assert.equal(
    journalControlError(saved, { deviceId: device, controlGeneration: 5 }, true, device),
    'CONTROL_GENERATION_STALE',
  );
  assert.equal(journalControlError(saved, null, false, other), 'CONTROL_DEVICE_CHANGED');
});
test('a pending autonomous packet cannot acquire the generation of a newer grant', () => {
  const saved = journal();
  saved.packet = {
    id: command,
    expectedVersion: 2,
    sessionId: command,
    type: 'OFFLINE_SYNC',
    events: [],
    deviceId: device,
    controlGeneration: 3,
  };
  const original = structuredClone(saved);
  assert.equal(journalControlError(saved, saved.grant!, true, device), 'CONTROL_PACKET_MISMATCH');
  assert.deepEqual(saved, original);
});
test('logout retries only the explicit rolled-back claim race, without navigating on an unknown response', async () => {
  let calls = 0;
  await logoutSession(async <T>() => {
    if (++calls === 1) throw new ApiError('ACCESS_CHANGED_RETRY', 409);
    return {} as T;
  });
  assert.equal(calls, 2);
  for (const problem of [
    new ApiError('SERVER_DOWN', 503),
    new ApiError('FORBIDDEN', 403),
    new Error('network'),
  ]) {
    calls = 0;
    await assert.rejects(
      logoutSession(async <T>() => {
        calls++;
        throw problem;
        return {} as T;
      }),
    );
    assert.equal(calls, 1);
  }
});
test('a repeated logout race remains a visible error instead of an endless automatic retry', async () => {
  let calls = 0;
  await assert.rejects(
    logoutSession(async <T>() => {
      calls++;
      throw new ApiError('ACCESS_CHANGED_RETRY', 409);
      return {} as T;
    }),
    /ACCESS_CHANGED_RETRY/,
  );
  assert.equal(calls, 2);
});
