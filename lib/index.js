// src/index.mjs
import { randomUUID } from "node:crypto";
import { buildForkSeed } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

// src/domain.mjs
var CONTROL = /[\u0000-\u001f\u007f]/u;
var TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
var STATUSES = /* @__PURE__ */ new Set(["active", "closed", "saved"]);
function validateId(value, label = "session id") {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || CONTROL.test(value)) {
    throw new TypeError(`${label} must be a nonempty string of at most 256 characters without control characters`);
  }
  return value;
}
function textValue(value, label, max, { blank = false } = {}) {
  if (typeof value !== "string" || !blank && !value.trim() || value.length > max || TEXT_CONTROL.test(value)) {
    throw new TypeError(`${label} must be ${blank ? "a" : "a nonempty"} text string of at most ${max} characters`);
  }
  return value;
}
function timestamp(value) {
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) ? Date.parse(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("timestamp must be nonnegative epoch milliseconds or an ISO timestamp");
  return parsed;
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function copyBoundary(value, depth = 0) {
  if (depth > 5) throw new TypeError("boundary metadata is too deeply nested");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return textValue(value, "boundary text", 4096, { blank: true });
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 64) return value.map((item) => copyBoundary(item, depth + 1));
  if (isPlainObject(value) && Object.keys(value).length <= 64) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(key) || CONTROL.test(key) || key.length > 128) {
        throw new TypeError("boundary metadata contains an invalid key");
      }
      output[key] = copyBoundary(item, depth + 1);
    }
    return output;
  }
  throw new TypeError("boundary must contain only bounded JSON data");
}
function normalizeRecord(input) {
  try {
    if (!isPlainObject(input)) return null;
    const createdAt = timestamp(input.createdAt);
    const updatedAt = timestamp(input.updatedAt);
    if (!STATUSES.has(input.status) || updatedAt < createdAt) return null;
    const title = textValue(input.title, "title", 160).replace(/\s+/gu, " ").trim();
    const record = {
      id: validateId(input.id, "record id"),
      parentId: validateId(input.parentId, "parent session id"),
      sessionId: validateId(input.sessionId),
      title,
      createdAt,
      updatedAt,
      status: input.status
    };
    if (record.parentId === record.sessionId) return null;
    if (input.boundary !== void 0) record.boundary = copyBoundary(input.boundary);
    return record;
  } catch {
    return null;
  }
}
function createRecord({ id, parentId, sessionId, title = "\u4FA7\u8FB9\u804A\u5929", now = Date.now(), boundary } = {}) {
  const record = normalizeRecord({ id, parentId, sessionId, title, createdAt: now, updatedAt: now, status: "active", boundary });
  if (!record) throw new TypeError("invalid side-chat record");
  return record;
}

// src/service.mjs
var PluginError = class extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "PluginError";
    this.code = code;
  }
};
function requestObject(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new PluginError("INVALID_ARGUMENT", "request must be an object");
  try {
    validateId(request.parentId, "parent session id");
  } catch (cause) {
    throw new PluginError("INVALID_ARGUMENT", cause.message, { cause });
  }
  return request;
}
var SidechatServiceCore = class {
  records = /* @__PURE__ */ new Map();
  locks = /* @__PURE__ */ new Map();
  closing = false;
  constructor({ sessions, now = Date.now, uuid = () => globalThis.crypto.randomUUID() } = {}) {
    for (const method of ["exists", "fork", "discard"]) if (typeof sessions?.[method] !== "function") throw new PluginError("INVALID_ADAPTER", `sessions.${method} must be a function`);
    this.sessions = sessions;
    this.now = now;
    this.uuid = uuid;
  }
  async parent(parentId) {
    if ([...this.records.values()].some((record) => record.sessionId === parentId)) throw new PluginError("NESTED_SIDE", "\u4FA7\u804A\u4E2D\u4E0D\u80FD\u518D\u521B\u5EFA\u4FA7\u804A\uFF0C\u8BF7\u56DE\u5230\u4E3B\u5BF9\u8BDD\u3002");
    if (!await this.sessions.exists(parentId)) throw new PluginError("PARENT_NOT_FOUND", "\u4E3B\u4F1A\u8BDD\u4E0D\u5B58\u5728\u3002");
  }
  async list(request) {
    const { parentId } = requestObject(request);
    await this.parent(parentId);
    const record = this.records.get(parentId);
    return record ? [structuredClone(record)] : [];
  }
  async open(request) {
    const { parentId, atSeq } = requestObject(request);
    if ("title" in request) throw new PluginError("EPHEMERAL", "\u4E34\u65F6\u4FA7\u804A\u4E0D\u80FD\u91CD\u547D\u540D\u3002");
    if (atSeq !== void 0 && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new PluginError("INVALID_ARGUMENT", "atSeq must be a nonnegative safe integer");
    return this.lock(parentId, async () => {
      if (this.closing) throw new PluginError("DISPOSED", "\u4FA7\u804A\u670D\u52A1\u6B63\u5728\u5173\u95ED\u3002");
      await this.parent(parentId);
      const existing = this.records.get(parentId);
      if (existing) return structuredClone(existing);
      const result = await this.sessions.fork(parentId, { atSeq });
      let record;
      try {
        record = createRecord({ id: this.uuid(), parentId, sessionId: result.sessionId, now: this.now(), boundary: result.boundary });
      } catch (cause) {
        await this.sessions.discard(result.sessionId);
        throw new PluginError("INVALID_ADAPTER_RESULT", "\u4FA7\u804A\u521D\u59CB\u5316\u5931\u8D25\uFF0C\u5DF2\u91CA\u653E\u4E34\u65F6\u4F1A\u8BDD\u3002", { cause });
      }
      if (this.closing) {
        await this.sessions.discard(record.sessionId);
        throw new PluginError("DISPOSED", "\u4FA7\u804A\u670D\u52A1\u6B63\u5728\u5173\u95ED\u3002");
      }
      this.records.set(parentId, record);
      return structuredClone(record);
    });
  }
  async discard(request) {
    const { parentId, id } = requestObject(request);
    if (typeof id !== "string" || !id) throw new PluginError("INVALID_ARGUMENT", "side-chat id is required");
    return this.lock(parentId, async () => {
      const record = this.records.get(parentId);
      if (!record) return { discarded: true };
      if (record.id !== id) throw new PluginError("SIDECHAT_NOT_FOUND", "\u8BE5\u4FA7\u804A\u4E0D\u5C5E\u4E8E\u6B64\u4E3B\u4F1A\u8BDD\u3002");
      await this.sessions.discard(record.sessionId);
      this.records.delete(parentId);
      return { discarded: true };
    });
  }
  async dispose() {
    this.closing = true;
    await Promise.allSettled([...this.locks.values()]);
    const results = await Promise.allSettled([...this.records.values()].map((record) => this.discard({ parentId: record.parentId, id: record.id })));
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "\u90E8\u5206\u4FA7\u804A\u672A\u80FD\u91CA\u653E");
  }
  async lock(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {
    }).then(operation);
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key);
    }
  }
};

// src/memory-persistence.mjs
import { SessionPersistence, SessionPersistenceNotFoundError, SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError, SessionReadOnlyError, assertContiguous, materializeCreateHeader, materializeAppendBatch } from "@deepseek-ai/dsh-session-persistence";
var TemporaryLogs = class {
  entries = /* @__PURE__ */ new Map();
  reservations = /* @__PURE__ */ new Set();
  reserve(id) {
    this.reservations.add(id);
  }
  owns(id) {
    return this.reservations.has(id);
  }
  forget(id) {
    this.entries.delete(id);
    this.reservations.delete(id);
  }
  async create(header, options) {
    options?.signal?.throwIfAborted();
    if (this.entries.has(header.id)) throw new SessionAlreadyExistsError(header.id);
    const entry = { header: materializeCreateHeader(header), inheritedEventCount: options?.inheritedEventCount ?? 0, events: [], writer: false, revision: 0 };
    this.entries.set(header.id, entry);
    return this.handle(entry, "write");
  }
  async open(id, access, options) {
    options?.signal?.throwIfAborted();
    const entry = this.entries.get(id);
    if (!entry) throw new SessionPersistenceNotFoundError(id);
    return this.handle(entry, access);
  }
  snapshot(entry) {
    return { header: structuredClone(entry.header), revision: `side:${entry.revision}`, eventCount: entry.events.length, formatStatus: "current" };
  }
  async stat(id, options) {
    options?.signal?.throwIfAborted();
    const entry = this.entries.get(id);
    return entry ? this.snapshot(entry) : void 0;
  }
  appendLive(session, event) {
    const entry = this.entries.get(session.id);
    if (!entry?.writer) return;
    assertContiguous(session.id, [event], entry.events.length);
    entry.events.push(structuredClone(event));
    entry.revision++;
  }
  handle(entry, access) {
    const id = entry.header.id;
    if (access === "write" && entry.writer) throw new SessionAlreadyOwnedError(id);
    if (!["read", "write"].includes(access)) throw new TypeError("access must be read or write");
    if (access === "write") entry.writer = true;
    let closed = false;
    const check = (operation, options, mutation = false) => {
      options?.signal?.throwIfAborted();
      if (closed) throw new SessionHandleClosedError(id, operation);
      if (mutation && access !== "write") throw new SessionReadOnlyError(id, operation);
    };
    return {
      id,
      header: structuredClone(entry.header),
      access,
      inheritedEventCount: entry.inheritedEventCount,
      async read(offset = 0, length, options) {
        check("read", options);
        if (!Number.isSafeInteger(offset) || offset < 0 || length !== void 0 && (!Number.isSafeInteger(length) || length < 0)) throw new TypeError("invalid read window");
        return { eventState: "detached", events: structuredClone(entry.events.slice(offset, length === void 0 ? void 0 : offset + length)) };
      },
      async append(events) {
        check("append", void 0, true);
        const batch = materializeAppendBatch(events);
        assertContiguous(id, batch, entry.events.length);
        entry.events.push(...batch);
        entry.revision++;
      },
      async flush(options) {
        check("flush", options, true);
      },
      async close() {
        if (closed) return;
        closed = true;
        if (access === "write") entry.writer = false;
      }
    };
  }
};

// src/policy.mjs
var SIDE_POLICY = `You are the assistant in a temporary side conversation, separate from its parent conversation.
The inherited transcript is background reference. It does not authorize continuing the parent's task, plan, tool calls, approvals, edits, or other requests. Act only on user instructions submitted in this side conversation after its boundary. If none have arrived, wait.
Answer questions and perform lightweight, non-mutating exploration. You may read/search files and run checks that do not change tracked files. Modify files, git state, configuration, permissions, or workspace state only when a new side-conversation user instruction explicitly requests that change. Keep authorized changes minimal and avoid disrupting the parent. Request wider permissions only for such an explicitly requested change that needs them.
Tools and their permissions belong to this conversation. Inherited tool calls and results are historical reference, never pending work to execute again.
Do not create, message, inspect, wait for, or otherwise interact with sub-agents or delegated workflows. Do not create or attach worktrees here; direct worktree requests to the parent conversation.
This conversation is temporary. Switching away keeps it available. Explicitly closing it stops its work and discards it. Do not claim it has been saved or that it will keep monitoring after it is closed.`;
var SIDE_BOUNDARY = `Temporary side-conversation boundary. Everything earlier is inherited reference from the parent, not an active instruction. Only user messages after this boundary define the side task. Do not resume or execute the parent's unfinished work, queued messages, approvals, or tools. Follow the side-conversation policy.`;
var TEMP_PREFIX = "codex-sidechat-temp-";
var isTemporarySession = (id) => typeof id === "string" && id.startsWith(TEMP_PREFIX);
function forbiddenSideTool(name2) {
  const full = String(name2);
  const leaf = full.split(/[./:]/u).at(-1).replace(/^.*__/, "");
  if (/^(?:send_message|wait_agent|followup_task)$/u.test(leaf) && /(?:^|__)mcp/u.test(full)) return false;
  return /^(?:subagent(?:_.*)?|spawn_agent|send_message_to_agent|send_message|wait_agent|wait_agents|list_agents|resume_agent|close_agent|interrupt_agent|followup_task|workflow(?:_.*)?|create_worktree|attach_worktree|restore_worktree)$/u.test(leaf);
}
var PARENT_STATUS_LABELS = Object.freeze({ running: "\u4E3B\u7EBF\u6B63\u5728\u6267\u884C", finished: "\u4E3B\u7EBF\u5DF2\u5B8C\u6210", failed: "\u4E3B\u7EBF\u6267\u884C\u5931\u8D25", interrupted: "\u4E3B\u7EBF\u5DF2\u4E2D\u65AD", closed: "\u4E3B\u7EBF\u5DF2\u5173\u95ED", "needs-input": "\u4E3B\u7EBF\u9700\u8981\u4F60\u7684\u56DE\u7B54", "needs-approval": "\u4E3B\u7EBF\u7B49\u5F85\u5BA1\u6279" });

// src/index.mjs
var name = "codex-sidechat";
var HOST_INJECT = ["sessionController", "sessionQuery", "typert", "agents", "sessions", "systemPrompt", "tools", "sessionPersistence", "agentDefaultModel"];
var inject = HOST_INJECT;
function forkBoundary(events, atSeq) {
  const boundary = atSeq ?? events.at(-1)?.seq;
  if (boundary === void 0 || !events.some((event) => event.type === "user/message" && event.seq <= boundary)) throw new PluginError("NOT_STARTED", "\u8BF7\u5148\u5411\u4E3B\u4F1A\u8BDD\u53D1\u9001\u4E00\u6761\u6D88\u606F\uFF0C\u518D\u6253\u5F00\u4FA7\u804A\u3002");
  if (!Number.isSafeInteger(boundary) || boundary < 0 || !events.some((event) => event.seq === boundary)) throw new PluginError("INVALID_ARGUMENT", "\u6307\u5B9A\u7684\u4E3B\u4F1A\u8BDD\u4E0A\u4E0B\u6587\u4F4D\u7F6E\u4E0D\u5B58\u5728\u3002");
  return boundary;
}
function createSessionAdapter(ctx, temporary = new TemporaryLogs()) {
  const handles = /* @__PURE__ */ new Map();
  return {
    async exists(id) {
      return Boolean(ctx.sessions.get(id) || await ctx.sessionPersistence.stat(id));
    },
    async fork(parentId, { atSeq } = {}) {
      if (isTemporarySession(parentId)) throw new PluginError("NESTED_SIDE", "\u4FA7\u804A\u4E2D\u4E0D\u80FD\u518D\u521B\u5EFA\u4FA7\u804A\u3002");
      const observed = await ctx.sessionQuery.observeSession(parentId);
      let seed, boundary, header, selection, parentAgent, presetId;
      try {
        const events = observed.events;
        boundary = forkBoundary(events, atSeq);
        header = observed.header;
        seed = buildForkSeed(events, boundary);
        const live = parentAgent = ctx.agents.get(parentId);
        presetId = observed.projections?.values.agentPreset ?? header.agentPreset;
        const projection = live ? ctx.get("sessionProjections")?.stateOf(live.session, "modelSelection") : void 0;
        const route = projection?.pending ?? live?.session.requestHeader()?.config ?? live?.options ?? ctx.agentDefaultModel.currentSelection();
        selection = { provider: route.provider, model: route.model, ...route.reasoningEffort === void 0 ? {} : { reasoningEffort: route.reasoningEffort } };
      } finally {
        observed[Symbol.dispose]?.();
      }
      const sessionId = `${TEMP_PREFIX}${randomUUID()}`;
      temporary.reserve(sessionId);
      const boundaryMessage = createUserMessage({ source: { kind: "codex-sidechat-boundary" }, content: [{ type: "text", text: `${SIDE_POLICY}

${SIDE_BOUNDARY}` }] });
      let handle;
      try {
        handle = await ctx.agents.create({
          sessionId,
          seed,
          inheritedEventCount: boundary + 1,
          meta: { ...header.cwd === void 0 ? {} : { cwd: header.cwd }, parentSession: parentId, isSeeded: true, ...presetId ? { agentPreset: presetId } : {} },
          agentOptions: selection,
          async setup(agentCtx, agent) {
            const presets = agentCtx.get("agentPresets");
            if (presets) {
              const inherited = parentAgent && presets.composeFrom(agentCtx, parentAgent.ctx);
              if (!inherited) await presets.mount(agentCtx, presetId);
            }
            agent.inbox.clear();
            agent.session.append("user/message", boundaryMessage, { surfaceOp: "append" });
            agentCtx.systemPrompt.section({ name: "codex-sidechat:policy", order: 2e4, text: SIDE_POLICY, interpolate: false });
            agentCtx.systemPrompt.context({ name: "codex-sidechat:policy", order: 2e4, text: SIDE_POLICY, required: true, interpolate: false });
            agentCtx.tools.guard((exec) => forbiddenSideTool(exec.name) ? "\u4E34\u65F6\u4FA7\u804A\u7981\u6B62\u5B50\u4EE3\u7406\u3001\u59D4\u6D3E\u5DE5\u4F5C\u6D41\u548C worktree \u64CD\u4F5C\u3002\u8BF7\u56DE\u5230\u4E3B\u5BF9\u8BDD\u6267\u884C\u3002" : void 0);
            agent.session.append("model/selection", selection);
          }
        });
        handles.set(sessionId, handle);
        return { sessionId, boundary: { inheritedMaxSeq: boundary, parentSeq: boundary, capturedAt: seed[boundary]?.time ?? Date.now(), hiddenMessageId: String(boundaryMessage.id), ephemeral: true } };
      } catch (error) {
        if (handle) await handle.dispose();
        temporary.forget(sessionId);
        throw error;
      }
    },
    async discard(sessionId) {
      const handle = handles.get(sessionId);
      if (!handle) throw new PluginError("NOT_OWNED", "\u5F53\u524D\u63D2\u4EF6\u4E0D\u6301\u6709\u8BE5\u4E34\u65F6\u4F1A\u8BDD\uFF0C\u672A\u6267\u884C\u5173\u95ED\u3002");
      handle.agent.cancel({ kind: "user" });
      await handle.agent.whenIdle();
      await handle.dispose();
      handles.delete(sessionId);
      temporary.forget(sessionId);
    }
  };
}
var initializers = [];
var CodexSidechatHost = class extends TypertRemoteService {
  static inject = HOST_INJECT;
  constructor(ctx, temporary) {
    super(ctx, "codexSidechatHost", { namespace: "codexSidechat" });
    for (const initialize of initializers) initialize.call(this);
    this.core = new SidechatServiceCore({ sessions: createSessionAdapter(ctx, temporary), uuid: randomUUID });
    ctx.effect(() => () => this.core.dispose(), "codex-sidechat: temporary lifetime");
  }
  async list(request) {
    return this.invoke("list", request);
  }
  async open(request) {
    return this.invoke("open", request);
  }
  async discard(request) {
    return this.invoke("discard", request);
  }
  async update() {
    throw new RemoteError("codex-sidechat/ephemeral", "\u4E34\u65F6\u4FA7\u804A\u4E0D\u80FD\u91CD\u547D\u540D\u6216\u6062\u590D\u5DF2\u4E22\u5F03\u7684\u8BB0\u5F55\u3002", {});
  }
  async save() {
    throw new RemoteError("codex-sidechat/ephemeral", "\u4E34\u65F6\u4FA7\u804A\u4E0D\u80FD\u53E6\u5B58\u4E3A\u6B63\u5F0F\u4F1A\u8BDD\uFF1B\u53EF\u5C06\u6240\u9700\u7ED3\u8BBA\u5E26\u56DE\u4E3B\u5BF9\u8BDD\u3002", {});
  }
  async invoke(method, request) {
    try {
      const value = await this.core[method](request);
      if (method === "open") return this.present(value);
      if (method === "list") return value.map((record) => this.present(record));
      return value;
    } catch (error) {
      if (!(error instanceof PluginError)) throw error;
      throw new RemoteError(`codex-sidechat/${error.code.toLowerCase().replaceAll("_", "-")}`, error.message, {});
    }
  }
  present(record) {
    const session = this.ctx.sessions.get(record.sessionId);
    if (!session) throw new PluginError("SIDECHAT_NOT_FOUND", "\u8BE5\u4E34\u65F6\u4F1A\u8BDD\u5DF2\u91CA\u653E\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u4FA7\u804A\u3002");
    return { ...record, summary: {
      sessionId: record.sessionId,
      updatedAt: session.snapshotEvents().at(-1)?.time ?? record.createdAt,
      running: this.ctx.agents.get(record.sessionId)?.status === "running",
      agentAvailable: true,
      blank: false,
      formatStatus: "current",
      parentSessionId: record.parentId,
      ...session.header.cwd === void 0 ? {} : { cwd: session.header.cwd }
    } };
  }
};
for (const method of ["list", "open", "discard", "update", "save"]) {
  Remote({ name: method, resources: { session: (request) => request.parentId } })(CodexSidechatHost.prototype[method], { kind: "method", name: method, static: false, private: false, addInitializer: (initialize) => initializers.push(initialize) });
}
function apply(ctx) {
  const temporary = ctx.sessionPersistence.temporary;
  if (!temporary) throw new Error("DSH Sidechat requires its bundled persistence adapter.");
  new CodexSidechatHost(ctx, temporary);
}
export {
  CodexSidechatHost,
  apply,
  createSessionAdapter,
  forkBoundary,
  inject,
  name
};
