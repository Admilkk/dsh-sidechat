import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createSessionAdapter, forkBoundary } from '../src/index.mjs';
import { TemporaryLogs } from '../src/memory-persistence.mjs';
import { SIDE_POLICY, SIDE_BOUNDARY } from '../src/policy.mjs';

function fixture({ failCreate = false, failDispose = false } = {}) {
  const parent = new Session('parent');
  parent.append('turn/start', { turn: 0 });
  parent.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'parent task' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  parent.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [createUserMessage({ content: [{ type: 'text', text: 'QUEUED_PARENT_ONLY' }], source: { kind: 'user' } })] });
  parent.append('model/selection', { provider: 'fixture', model: 'latest' });
  const calls = [], temporary = new TemporaryLogs();
  const local = new Map([['parent', parent]]);
  let createOptions, child;
  const scope = { get: () => undefined, systemPrompt: { section: value => calls.push(['section', value]), context: value => calls.push(['context', value]) }, tools: { guard: value => calls.push(['guard', value]) } };
  const ctx = {
    sessions: { get: id => local.get(id) },
    agents: {
      get: id => id === 'parent' ? { session: parent, options: { provider: 'fixture', model: 'latest', reasoningEffort: 'high' } } : undefined,
      async create(options) {
        createOptions = options;
        if (failCreate) throw new Error('creation failed');
        child = new Session(options.sessionId, options.seed);
        const agent = { session: child, inbox: { clear: () => calls.push(['clear-child-inbox']) }, cancel: cause => calls.push(['cancel', cause]), whenIdle: async () => calls.push(['idle']) };
        await options.setup(scope, agent);
        local.set(options.sessionId, child);
        return { agent, async dispose() { calls.push(['dispose']); if (failDispose) throw new Error('dispose failed'); local.delete(options.sessionId); } };
      },
    },
    get: () => undefined,
    sessionPersistence: { stat: async () => undefined },
    agentDefaultModel: { currentSelection: () => ({ provider: 'wrong-default', model: 'wrong-default' }) },
    sessionQuery: { async observeSession() { return { header: parent.header, events: parent.snapshotEvents(), [Symbol.dispose]() { calls.push(['release-observation']); } }; } },
  };
  return { adapter: createSessionAdapter(ctx, temporary), parent, calls, temporary, options: () => createOptions, child: () => child };
}

test('latest committed progress is kept even while parent input is queued', async () => {
  const f = fixture(); const before = f.parent.snapshotEvents();
  const record = await f.adapter.fork('parent');
  assert.equal(record.boundary.parentSeq, before.at(-1).seq);
  assert.equal(record.boundary.ephemeral, true);
  assert.deepEqual(f.options().seed.slice(0, before.length), before);
  assert.deepEqual(f.parent.snapshotEvents(), before);
  assert.equal(f.calls.filter(call => call[0] === 'clear-child-inbox').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'release-observation').length, 1);
  assert.ok(f.options().seed.some(event => event.type === 'turn/end' && event.data.reason.kind === 'forked'));
});

test('boundary and standing policy are included in model history without a user turn', async () => {
  const f = fixture(); await f.adapter.fork('parent');
  const developers = f.child().deriveMessages().filter(message => message.source?.kind === 'codex-sidechat-boundary');
  const text = developers.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
  assert.ok(text.includes(SIDE_POLICY)); assert.ok(text.includes(SIDE_BOUNDARY));
  assert.deepEqual(f.calls.find(call => call[0] === 'context')[1], { name: 'codex-sidechat:policy', order: 20000, text: SIDE_POLICY, required: true, interpolate: false });
  assert.equal(f.calls.some(call => call[0] === 'cancel'), false);
  const guard = f.calls.find(call => call[0] === 'guard')[1];
  assert.match(guard({ name: 'subagent' }), /禁止/);
  assert.equal(guard({ name: 'read' }), undefined);
});

test('side creation inherits model and reasoning selection instead of the global default', async () => {
  const f = fixture(); await f.adapter.fork('parent');
  assert.deepEqual(f.options().agentOptions, { provider: 'fixture', model: 'latest', reasoningEffort: 'high' });
});

test('discard cancels, drains and disposes only the owned child in order', async () => {
  const f = fixture(); const record = await f.adapter.fork('parent');
  await f.adapter.discard(record.sessionId);
  assert.deepEqual(f.calls.slice(-3).map(call => call[0]), ['cancel', 'idle', 'dispose']);
  assert.equal(f.temporary.owns(record.sessionId), false);
  await assert.rejects(f.adapter.discard('parent'), { code: 'NOT_OWNED' });
});

test('failed creation releases the memory reservation; failed disposal preserves ownership', async () => {
  const bad = fixture({ failCreate: true });
  await assert.rejects(bad.adapter.fork('parent'), /creation failed/);
  assert.equal(bad.temporary.reservations.size, 0);
  const held = fixture({ failDispose: true }); const record = await held.adapter.fork('parent');
  await assert.rejects(held.adapter.discard(record.sessionId), /dispose failed/);
  assert.equal(held.temporary.owns(record.sessionId), true);
});

test('invalid and unstarted boundaries are rejected', () => {
  assert.throws(() => forkBoundary([]), { code: 'NOT_STARTED' });
  assert.throws(() => forkBoundary([{ seq: 0, type: 'user/message' }], 99), { code: 'INVALID_ARGUMENT' });
});
