import { Context } from '@deepseek-ai/cordis';
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SidechatPersistence, TemporaryLogs } from './memory-persistence.mjs';

export const name = 'session-persistence-jsonl';
export const Config = jsonl.Config;

/** The native provider owns the routing lifetime, independently of the sidechat UI. */
export async function apply(ctx, config) {
  await ctx.effect(async function* () {
    const nativeCtx = ctx.isolate('sessionPersistence');
    const backend = nativeCtx.plugin(jsonl, config);
    yield backend.dispose;
    await backend.await();
    const publicLabel = ctx[Context.isolate].sessionPersistence;
    const router = nativeCtx.inject(['sessionPersistence'], readyCtx => {
      const durable = readyCtx.sessionPersistence;
      readyCtx.isolate('sessionPersistence', publicLabel).plugin({
        name: 'codex-sidechat-persistence',
        apply(routerCtx) { new SidechatPersistence(routerCtx, durable, new TemporaryLogs()); },
      });
    });
    yield router.dispose;
    await router.await();
  }, 'codex-sidechat: persistence lifetime');
}
