import test from 'node:test';
import assert from 'node:assert/strict';
import { TemporaryLogs, SidechatPersistence } from '../src/memory-persistence.mjs';
import { Context } from '@deepseek-ai/cordis';
import { QuerySessions } from '../src/query-view.mjs';

const header = id => ({ version: 4, id, createdAt: 1000, isSeeded: false, delegationDepth: 0 });
const event = seq => ({ seq, type: 'turn/start', time: 1000, data: { turn: 0 } });

test('query view omits temporary sessions from enumeration without breaking direct reads or ordinary sessions', async () => {
  const ctx = new Context();
  const main = { id: 'main' }, side = { id: 'codex-sidechat-temp-fixture' };
  const backend = { list: () => [main, side], get: id => id === side.id ? side : main, prepare: id => ({ id }), messageProjections: [] };
  let view;
  ctx.plugin({ name: 'query-view-test', apply: scoped => { view = new QuerySessions(scoped, backend); } });
  await ctx.fiber.await();
  assert.deepEqual(view.list(), [main]);
  assert.equal(view.get(side.id), side);
  assert.deepEqual(view.prepare('cold'), { id: 'cold' });
  assert.deepEqual(backend.list(), [main, side]);
  await ctx.fiber.dispose();
});

test('temporary handles enforce read isolation, sequential append, ownership and closure', async () => {
  const logs = new TemporaryLogs(); logs.reserve('side');
  const writer = await logs.create(header('side'));
  await writer.append([event(0)]);
  await assert.rejects(writer.append([event(2)]), /seq mismatch/);
  await assert.rejects(logs.open('side', 'write'), { name: 'SessionAlreadyOwnedError' });
  const reader = await logs.open('side', 'read');
  const first = await reader.read(); first.events[0].data.turn = 9;
  assert.equal((await reader.read()).events[0].data.turn, 0);
  await assert.rejects(reader.append([event(1)]), { name: 'SessionReadOnlyError' });
  await assert.rejects(reader.flush(), { name: 'SessionReadOnlyError' });
  await writer.append([event(1)]);
  assert.equal((await reader.read()).events.length, 2);
  await reader.close(); await reader.close();
  await assert.rejects(reader.read(), { name: 'SessionHandleClosedError' });
  await writer.close(); logs.forget('side');
  await assert.rejects(logs.open('side', 'read'), { name: 'SessionPersistenceNotFoundError' });
});
test('only reserved side IDs use memory; ordinary sessions delegate unchanged', async () => {
  const ctx = new Context();
  const calls = [];
  const durable = Object.fromEntries(['create', 'open', 'stat', 'list', 'flush'].map(name => [name, async (...args) => { calls.push([name, ...args]); return name === 'list' ? [{ header: header('main') }] : 'durable-result'; }]));
  let service;
  ctx.plugin({ name: 'test-router', apply: scoped => { service = new SidechatPersistence(scoped, durable, new TemporaryLogs()); } });
  await ctx.fiber.await();
  service.temporary.reserve('side');
  const writer = await service.create(header('side'));
  await writer.append([event(0)]);
  assert.equal((await service.stat('side')).eventCount, 1);
  assert.deepEqual(await service.list(), [{ header: header('main') }]);
  assert.equal(await service.create(header('main')), 'durable-result');
  assert.equal(await service.open('main', 'read'), 'durable-result');
  assert.equal(await service.stat('main'), 'durable-result');
  await service.flush();
  assert.ok(calls.every(call => !JSON.stringify(call).includes('side')));
  ctx.emit('session/event', { id: 'side' }, event(1));
  assert.equal((await writer.read()).events.length, 2);
  await writer.close(); service.temporary.forget('side');
  await ctx.fiber.dispose();
});
