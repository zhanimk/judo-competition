import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

// Synthetic integration clients use the same explicit control API as the real UI.
// This helper never invents or steals a grant. Access-specific tests use raw HTTP.
const devices = new Map();
const claims = new Map();
const commandGrants = new Map();
const invitations = new Map();
const deviceKey = (base, cookie, mat) => JSON.stringify([base, cookie, mat]);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const headers = (cookie) => ({
  'Content-Type': 'application/json',
  'X-Judo-Client': 'web',
  Cookie: cookie,
});
async function raw(base, path, data, cookie) {
  return fetch(base + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: headers(cookie),
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
function device(base, cookie, mat) {
  const key = deviceKey(base, cookie, mat);
  if (!devices.has(key)) devices.set(key, randomUUID());
  return devices.get(key);
}
export async function fixtureControl(base, mat, cookie, type = 'CLAIM') {
  const deviceId = device(base, cookie, mat);
  const status = await raw(
    base,
    `/auth/tatamis/${mat}/control?deviceId=${deviceId}`,
    undefined,
    cookie,
  );
  if (!status.ok) return { deviceId, controlGeneration: 0, denied: status.status };
  const current = await status.json();
  if (type === 'CLAIM' && current.control.owned)
    return { deviceId, controlGeneration: current.control.generation };
  const result = await raw(
    base,
    `/auth/tatamis/${mat}/control`,
    {
      id: randomUUID(),
      expectedRevision: current.accessRevision,
      deviceId,
      type,
      ...(type === 'TAKEOVER'
        ? { reason: 'Explicit handover between synthetic integration clients' }
        : {}),
    },
    cookie,
  );
  const body = await result.json();
  assert.equal(result.status, 201, `Fixture ${type} failed: ${body.message ?? result.status}`);
  return { deviceId, controlGeneration: body.control.generation };
}
async function grant(base, mat, cookie) {
  const key = deviceKey(base, cookie, mat);
  // Serialise the initial CLAIM when a fixture intentionally races two commands.
  if (!claims.has(key)) claims.set(key, fixtureControl(base, mat, cookie));
  const initial = await claims.get(key);
  if (initial.denied) return initial;
  const current = await raw(
    base,
    `/auth/tatamis/${mat}/control?deviceId=${initial.deviceId}`,
    undefined,
    cookie,
  );
  if (!current.ok) return initial;
  const body = await current.json();
  return { deviceId: initial.deviceId, controlGeneration: body.control.generation };
}
export async function fixtureRequest(base, path, data, cookie = '') {
  let payload = data;
  const sport = /^\/tatamis\/([^/]+)\/live\/[^/]+\/command$/.exec(path);
  const invite = /^\/auth\/tatamis\/([^/]+)\/invitations$/.exec(path);
  const revoke = /^\/auth\/invitations\/([^/]+)\/revoke$/.exec(path);
  if (data && sport && !('deviceId' in data)) {
    // A deliberate reuse of an ID with different content is a new rejected
    // intent; an exact retry must retain its original controller generation.
    const key = JSON.stringify(canonical([base, cookie, path, data]));
    if (!commandGrants.has(key)) commandGrants.set(key, grant(base, sport[1], cookie));
    const g = await commandGrants.get(key);
    payload = { ...data, deviceId: g.deviceId, controlGeneration: g.controlGeneration };
  } else if (data && invite && !('expectedRevision' in data)) {
    const status = await raw(base, `/auth/tatamis/${invite[1]}/control`, undefined, cookie);
    const control = status.ok ? await status.json() : null;
    payload = {
      ...data,
      id: data.id ?? randomUUID(),
      token: data.token ?? randomBytes(32).toString('hex'),
      expectedRevision: control?.accessRevision ?? 0,
    };
  } else if (data && revoke && !('expectedRevision' in data)) {
    const mat = invitations.get(JSON.stringify([base, revoke[1]]));
    assert.ok(mat, 'Fixture invitation must be issued by this helper before revoke');
    const status = await raw(base, `/auth/tatamis/${mat}/control`, undefined, cookie);
    const control = status.ok ? await status.json() : null;
    payload = {
      ...data,
      id: data.id ?? randomUUID(),
      expectedRevision: control?.accessRevision ?? 0,
      reason: 'Explicit revocation in isolated integration fixture',
    };
  }
  const administration = /^\/tournaments\/([^/]+)\/(start|schedule|publish|categories)$/.exec(path);
  if (data && !data.id && path === '/tournaments') payload = { ...data, id: randomUUID() };
  else if (data && !data.id && administration) {
    const current = await raw(base, `/tournaments/${administration[1]}`, undefined, cookie);
    const tournament = current.ok ? await current.json() : null;
    payload = {
      ...data,
      id: randomUUID(),
      expectedRevision: tournament?.administrationRevision ?? 0,
    };
  }
  const drawCommand = /^\/categories\/([^/]+)\/draw\/(preview|confirm|publication)$/.exec(path);
  if (data && !data.id && drawCommand) {
    const current = await raw(base, `/categories/${drawCommand[1]}/draw`, undefined, cookie);
    const state = current.ok ? await current.json() : null;
    payload = {
      ...data,
      id: randomUUID(),
      ...(drawCommand[2] === 'preview' ? { expectedVersion: state?.draw?.version ?? 0 } : {}),
    };
  }
  const response = await raw(base, path, payload, cookie);
  if (data && invite && response.ok) {
    const issued = await response.clone().json();
    invitations.set(JSON.stringify([base, issued.id]), invite[1]);
  }
  return response;
}
