import test from 'node:test';
import assert from 'node:assert/strict';
import { SidechatServiceCore } from '../src/service.mjs';

function fixture(overrides = {}) {
  let serial = 0;
  const calls = [];
  const sessions = {
    exists: async id => id !== 'missing',
    fork: async (id, options) => { calls.push(['fork', id, options]); return { sessionId: `child-${++serial}`, boundary: { inheritedMaxSeq: 5 } }; },
    discard: async id => { calls.push(['discard', id]); },
    ...overrides,
  };
  return { core: new SidechatServiceCore({ sessions, uuid: () => `record-${serial}`, now: () => 1000 }), calls };
}

test('concurrent opens and switching reuse one independent fork per parent', async () => {
  const { core, calls } = fixture();
  const records = await Promise.all(Array.from({ length: 12 }, () => core.open({ parentId: 'parent' })));
  assert.equal(new Set(records.map(record => record.sessionId)).size, 1);
  assert.equal(calls.length, 1);
  assert.equal((await core.list({ parentId: 'parent' })).length, 1);
  assert.notEqual((await core.open({ parentId: 'other' })).sessionId, records[0].sessionId);
});

test('explicit discard is idempotent and a subsequent open creates a fresh snapshot', async () => {
  const { core, calls } = fixture();
  const old = await core.open({ parentId: 'parent' });
  await core.discard({ parentId: 'parent', id: old.id });
  await core.discard({ parentId: 'parent', id: old.id });
  assert.deepEqual(await core.list({ parentId: 'parent' }), []);
  assert.notEqual((await core.open({ parentId: 'parent' })).sessionId, old.sessionId);
  assert.equal(calls.filter(call => call[0] === 'discard').length, 1);
});

test('a stale close cannot discard a replacement side conversation', async () => {
  const { core } = fixture();
  const old = await core.open({ parentId: 'parent' });
  await core.discard({ parentId: 'parent', id: old.id });
  const current = await core.open({ parentId: 'parent' });
  await assert.rejects(core.discard({ parentId: 'parent', id: old.id }), { code: 'SIDECHAT_NOT_FOUND' });
  assert.equal((await core.list({ parentId: 'parent' }))[0].id, current.id);
});

test('failed cancellation retains the side and allows retry', async () => {
  let fail = true;
  const { core } = fixture({ discard: async () => { if (fail) throw new Error('cannot stop'); } });
  const record = await core.open({ parentId: 'parent' });
  await assert.rejects(core.discard({ parentId: 'parent', id: record.id }), /cannot stop/);
  assert.equal((await core.list({ parentId: 'parent' })).length, 1);
  fail = false;
  await core.discard({ parentId: 'parent', id: record.id });
  assert.deepEqual(await core.list({ parentId: 'parent' }), []);
});

test('nested sides and cross-parent close requests are rejected', async () => {
  const { core, calls } = fixture();
  const first = await core.open({ parentId: 'parent' });
  await assert.rejects(core.open({ parentId: first.sessionId }), { code: 'NESTED_SIDE' });
  const other = await core.open({ parentId: 'other' });
  await assert.rejects(core.discard({ parentId: 'other', id: first.id }), { code: 'SIDECHAT_NOT_FOUND' });
  assert.equal((await core.list({ parentId: 'other' }))[0].id, other.id);
  assert.equal(calls.filter(call => call[0] === 'discard').length, 0);
});

test('invalid inputs and rename requests do not allocate sessions', async () => {
  const { core, calls } = fixture();
  for (const request of [null, [], {}, { parentId: '' }, { parentId: 'parent', atSeq: -1 }]) await assert.rejects(core.open(request), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(core.open({ parentId: 'parent', title: 'rename' }), { code: 'EPHEMERAL' });
  await assert.rejects(core.open({ parentId: 'missing' }), { code: 'PARENT_NOT_FOUND' });
  assert.equal(calls.length, 0);
});

test('failed creation leaves no relationship and later opens can retry', async () => {
  let fail = true;
  const { core } = fixture({ fork: async () => { if (fail) throw new Error('startup failed'); return { sessionId: 'new-child' }; } });
  await assert.rejects(core.open({ parentId: 'parent' }), /startup failed/);
  assert.deepEqual(await core.list({ parentId: 'parent' }), []);
  fail = false;
  assert.equal((await core.open({ parentId: 'parent' })).sessionId, 'new-child');
});

test('service shutdown waits for in-flight creation and destroys the unexposed child', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const { core, calls } = fixture({ fork: async () => { started(); await new Promise(resolve => { release = resolve; }); return { sessionId: 'during-shutdown' }; } });
  const creating = core.open({ parentId: 'parent' });
  await began;
  const stopped = core.dispose();
  release();
  await assert.rejects(creating, { code: 'DISPOSED' });
  await stopped;
  assert.deepEqual(calls, [['discard', 'during-shutdown']]);
  await assert.rejects(core.open({ parentId: 'parent' }), { code: 'DISPOSED' });
});

test('service restart does not reload temporary records', async () => {
  const first = fixture();
  await first.core.open({ parentId: 'parent' });
  await first.core.dispose();
  assert.equal(first.calls.filter(call => call[0] === 'discard').length, 1);
  assert.deepEqual(await fixture().core.list({ parentId: 'parent' }), []);
});
