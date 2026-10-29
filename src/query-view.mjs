import { Context, Service } from '@deepseek-ai/cordis';
import { isTemporarySession } from './policy.mjs';

/** Query-only store view: enumerate ordinary sessions; exact side reads still work. */
export class QuerySessions extends Service {
  constructor(ctx, sessions) { super(ctx, 'sessions'); this.backend = { api: sessions }; }
  list() { return this.backend.api.list().filter(session => !isTemporarySession(session.id)); }
  get(id) { return this.backend.api.get(id); }
  prepare(...args) { return this.backend.api.prepare(...args); }
  get messageProjections() { return this.backend.api.messageProjections; }
}

export const name = 'codex-sidechat-query-view';
export const inject = [];
export function apply(ctx) {
  const label = ctx[Context.isolate].sessions;
  ctx.isolate('sessions', ctx.root[Context.isolate].sessions).inject(['sessions'], nativeCtx => {
    const sessions = nativeCtx.sessions;
    nativeCtx.isolate('sessions', label).plugin({ name, apply: viewCtx => { new QuerySessions(viewCtx, sessions); } });
  });
}
