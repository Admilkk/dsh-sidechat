import { Service } from '@deepseek-ai/cordis';
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite';
import { isTemporarySession } from './policy.mjs';

/** Query-only store view: enumerate ordinary sessions; exact side reads still work. */
export class QuerySessions extends Service {
  constructor(ctx, sessions) { super(ctx, 'sessions'); this.backend = { api: sessions }; }
  list() { return this.backend.api.list().filter(session => !isTemporarySession(session.id)); }
  get(id) { return this.backend.api.get(id); }
  prepare(...args) { return this.backend.api.prepare(...args); }
  get messageProjections() { return this.backend.api.messageProjections; }
}

export const name = 'session-query-sqlite';
export const Config = SqliteSessionQueryEngine.Config;
export const inject = ['sessions'];
export async function apply(ctx, config) {
  const sessions = ctx.sessions;
  const queryCtx = ctx.isolate('sessions');
  await queryCtx.plugin({ name: 'codex-sidechat-query-sessions', apply(viewCtx) { new QuerySessions(viewCtx, sessions); } }).await();
  await queryCtx.plugin(SqliteSessionQueryEngine, config).await();
}
