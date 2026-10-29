import { createRecord, validateId } from './domain.mjs';

export class PluginError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'PluginError'; this.code = code; }
}

function requestObject(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new PluginError('INVALID_ARGUMENT', 'request must be an object');
  try { validateId(request.parentId, 'parent session id'); } catch (cause) { throw new PluginError('INVALID_ARGUMENT', cause.message, { cause }); }
  return request;
}

/** One temporary fork per parent. The adapter alone owns native session teardown. */
export class SidechatServiceCore {
  records = new Map();
  locks = new Map();
  closing = false;

  constructor({ sessions, now = Date.now, uuid = () => globalThis.crypto.randomUUID() } = {}) {
    for (const method of ['exists', 'fork', 'discard']) if (typeof sessions?.[method] !== 'function') throw new PluginError('INVALID_ADAPTER', `sessions.${method} must be a function`);
    this.sessions = sessions; this.now = now; this.uuid = uuid;
  }

  async parent(parentId) {
    if ([...this.records.values()].some(record => record.sessionId === parentId)) throw new PluginError('NESTED_SIDE', '侧聊中不能再创建侧聊，请回到主对话。');
    if (!(await this.sessions.exists(parentId))) throw new PluginError('PARENT_NOT_FOUND', '主会话不存在。');
  }

  async list(request) {
    const { parentId } = requestObject(request);
    await this.parent(parentId);
    const record = this.records.get(parentId);
    return record ? [structuredClone(record)] : [];
  }

  async open(request) {
    const { parentId, atSeq } = requestObject(request);
    if ('title' in request) throw new PluginError('EPHEMERAL', '临时侧聊不能重命名。');
    if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new PluginError('INVALID_ARGUMENT', 'atSeq must be a nonnegative safe integer');
    return this.lock(parentId, async () => {
      if (this.closing) throw new PluginError('DISPOSED', '侧聊服务正在关闭。');
      await this.parent(parentId);
      const existing = this.records.get(parentId);
      if (existing) return structuredClone(existing);
      const result = await this.sessions.fork(parentId, { atSeq });
      let record;
      try {
        record = createRecord({ id: this.uuid(), parentId, sessionId: result.sessionId, now: this.now(), boundary: result.boundary });
      } catch (cause) {
        await this.sessions.discard(result.sessionId);
        throw new PluginError('INVALID_ADAPTER_RESULT', '侧聊初始化失败，已释放临时会话。', { cause });
      }
      if (this.closing) { await this.sessions.discard(record.sessionId); throw new PluginError('DISPOSED', '侧聊服务正在关闭。'); }
      this.records.set(parentId, record);
      return structuredClone(record);
    });
  }

  async discard(request) {
    const { parentId, id } = requestObject(request);
    if (typeof id !== 'string' || !id) throw new PluginError('INVALID_ARGUMENT', 'side-chat id is required');
    return this.lock(parentId, async () => {
      const record = this.records.get(parentId);
      if (!record) return { discarded: true };
      if (record.id !== id) throw new PluginError('SIDECHAT_NOT_FOUND', '该侧聊不属于此主会话。');
      // Keep ownership and the visible record on any cancellation/disposal failure.
      await this.sessions.discard(record.sessionId);
      this.records.delete(parentId);
      return { discarded: true };
    });
  }

  async dispose() {
    this.closing = true;
    await Promise.allSettled([...this.locks.values()]);
    const results = await Promise.allSettled([...this.records.values()].map(record => this.discard({ parentId: record.parentId, id: record.id })));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, '部分侧聊未能释放');
  }

  async lock(key, operation) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.locks.set(key, task);
    try { return await task; } finally { if (this.locks.get(key) === task) this.locks.delete(key); }
  }
}
