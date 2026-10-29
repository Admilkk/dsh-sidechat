// src/query-view.mjs
import { Context, Service } from "@deepseek-ai/cordis";

// src/policy.mjs
var TEMP_PREFIX = "codex-sidechat-temp-";
var isTemporarySession = (id) => typeof id === "string" && id.startsWith(TEMP_PREFIX);
var PARENT_STATUS_LABELS = Object.freeze({ running: "\u4E3B\u7EBF\u6B63\u5728\u6267\u884C", finished: "\u4E3B\u7EBF\u5DF2\u5B8C\u6210", failed: "\u4E3B\u7EBF\u6267\u884C\u5931\u8D25", interrupted: "\u4E3B\u7EBF\u5DF2\u4E2D\u65AD", closed: "\u4E3B\u7EBF\u5DF2\u5173\u95ED", "needs-input": "\u4E3B\u7EBF\u9700\u8981\u4F60\u7684\u56DE\u7B54", "needs-approval": "\u4E3B\u7EBF\u7B49\u5F85\u5BA1\u6279" });

// src/query-view.mjs
var QuerySessions = class extends Service {
  constructor(ctx, sessions) {
    super(ctx, "sessions");
    this.backend = { api: sessions };
  }
  list() {
    return this.backend.api.list().filter((session) => !isTemporarySession(session.id));
  }
  get(id) {
    return this.backend.api.get(id);
  }
  prepare(...args) {
    return this.backend.api.prepare(...args);
  }
  get messageProjections() {
    return this.backend.api.messageProjections;
  }
};
var name = "codex-sidechat-query-view";
var inject = [];
function apply(ctx) {
  const label = ctx[Context.isolate].sessions;
  ctx.isolate("sessions", ctx.root[Context.isolate].sessions).inject(["sessions"], (nativeCtx) => {
    const sessions = nativeCtx.sessions;
    nativeCtx.isolate("sessions", label).plugin({ name, apply: (viewCtx) => {
      new QuerySessions(viewCtx, sessions);
    } });
  });
}
export {
  QuerySessions,
  apply,
  inject,
  name
};
