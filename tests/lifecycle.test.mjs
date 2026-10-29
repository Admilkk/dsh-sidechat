import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import * as persistence from '../src/persistence.mjs';
import * as query from '../src/query-view.mjs';

test('disabling and re-enabling the sidechat consumer preserves native storage and search services', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-sidechat-lifecycle-'));
  const ctx = new Context();
  try {
    await ctx.plugin(SessionStore).await();
    await ctx.plugin(persistence, { root: path.join(root, 'sessions'), compression: 'none' }).await();
    await ctx.plugin(query, { path: path.join(root, 'search.sqlite'), openAt: 'first-search' }).await();
    await new Promise(resolve => ctx.inject(['sessionQuery'], resolve));
    assert.ok(ctx.sessionPersistence);
    assert.ok(ctx.sessionQuery);
    const provider = ctx.sessionPersistence;
    const main = await provider.create({ version: 4, id: 'main', createdAt: Date.now(), isSeeded: false, delegationDepth: 0 });
    await main.flush();
    await main.close();
    const consumer = { name: 'sidechat-consumer', inject: ['sessionPersistence', 'sessionQuery'], apply(readyCtx) {
      assert.equal(readyCtx.sessionPersistence.identity, provider.identity);
      assert.equal(readyCtx.sessionQuery.name, 'sessionQuery');
      readyCtx.sessionPersistence.temporary.reserve('codex-sidechat-temp-lifecycle');
      readyCtx.effect(() => () => readyCtx.sessionPersistence.temporary.forget('codex-sidechat-temp-lifecycle'));
    } };
    for (let i = 0; i < 2; i++) {
      const sidechat = ctx.plugin(consumer);
      await sidechat.await();
      assert.equal(provider.temporary.owns('codex-sidechat-temp-lifecycle'), true);
      await sidechat.dispose();
      assert.equal(provider.temporary.owns('codex-sidechat-temp-lifecycle'), false);
      assert.equal(ctx.sessionPersistence.identity, provider.identity);
      assert.ok((await ctx.sessionQuery.listSessions()).some(item => item.header.id === 'main'));
      const restored = await ctx.sessionPersistence.open('main', 'read');
      assert.equal(restored.header.id, 'main');
      await restored.close();
      assert.ok((await ctx.sessionPersistence.list()).some(item => item.header.id === 'main'));
    }
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
