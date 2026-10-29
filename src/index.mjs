import { randomUUID } from 'node:crypto';
import { buildForkSeed } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { SidechatServiceCore, PluginError } from './service.mjs';
import { TemporaryLogs } from './memory-persistence.mjs';
import { SIDE_POLICY, SIDE_BOUNDARY, TEMP_PREFIX, forbiddenSideTool, isTemporarySession } from './policy.mjs';

export const name = 'codex-sidechat';
const HOST_INJECT = ['sessionController', 'sessionQuery', 'typert', 'agents', 'sessions', 'systemPrompt', 'tools', 'sessionPersistence', 'agentDefaultModel'];
export const inject = HOST_INJECT;

export function forkBoundary(events, atSeq) {
  const boundary = atSeq ?? events.at(-1)?.seq;
  if (boundary === undefined || !events.some(event => event.type === 'user/message' && event.seq <= boundary)) throw new PluginError('NOT_STARTED', '请先向主会话发送一条消息，再打开侧聊。');
  if (!Number.isSafeInteger(boundary) || boundary < 0 || !events.some(event => event.seq === boundary)) throw new PluginError('INVALID_ARGUMENT', '指定的主会话上下文位置不存在。');
  return boundary;
}

/** Exact latest committed prefix; clear copied inboxes in the child, never rewind the parent. */
export function createSessionAdapter(ctx, temporary = new TemporaryLogs()) {
  const handles = new Map();
  return {
    async exists(id) { return Boolean(ctx.sessions.get(id) || await ctx.sessionPersistence.stat(id)); },
    async fork(parentId, { atSeq } = {}) {
      if (isTemporarySession(parentId)) throw new PluginError('NESTED_SIDE', '侧聊中不能再创建侧聊。');
      const observed = await ctx.sessionQuery.observeSession(parentId);
      let seed, boundary, header, selection, parentAgent, presetId;
      try {
        const events = observed.events;
        boundary = forkBoundary(events, atSeq);
        header = observed.header;
        seed = buildForkSeed(events, boundary);
        const live = parentAgent = ctx.agents.get(parentId);
        presetId = observed.projections?.values.agentPreset ?? header.agentPreset;
        const projection = live ? ctx.get('sessionProjections')?.stateOf(live.session, 'modelSelection') : undefined;
        const route = projection?.pending ?? live?.session.requestHeader()?.config ?? live?.options ?? ctx.agentDefaultModel.currentSelection();
        selection = { provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) };
      } finally { observed[Symbol.dispose]?.(); }
      const sessionId = `${TEMP_PREFIX}${randomUUID()}`;
      temporary.reserve(sessionId);
      const boundaryMessage = createUserMessage({ source: { kind: 'codex-sidechat-boundary' }, content: [{ type: 'text', text: `${SIDE_POLICY}\n\n${SIDE_BOUNDARY}` }] });
      let handle;
      try {
        handle = await ctx.agents.create({
          sessionId, seed, inheritedEventCount: boundary + 1,
          meta: { ...(header.cwd === undefined ? {} : { cwd: header.cwd }), parentSession: parentId, isSeeded: true, ...(presetId ? { agentPreset: presetId } : {}) },
          agentOptions: selection,
          async setup(agentCtx, agent) {
            const presets = agentCtx.get('agentPresets');
            if (presets) {
              const inherited = parentAgent && presets.composeFrom(agentCtx, parentAgent.ctx);
              if (!inherited) await presets.mount(agentCtx, presetId);
            }
            agent.inbox.clear();
            // DSH's adapter pipeline reserves developer messages for tool updates and
            // can strip other developer text. Use its sourced context-message seam.
            agent.session.append('user/message', boundaryMessage, { surfaceOp: 'append' });
            agentCtx.systemPrompt.section({ name: 'codex-sidechat:policy', order: 20000, text: SIDE_POLICY, interpolate: false });
            // Required runtime context survives complete-persona presets and later compaction.
            agentCtx.systemPrompt.context({ name: 'codex-sidechat:policy', order: 20000, text: SIDE_POLICY, required: true, interpolate: false });
            agentCtx.tools.guard(exec => forbiddenSideTool(exec.name) ? '临时侧聊禁止子代理、委派工作流和 worktree 操作。请回到主对话执行。' : undefined);
            agent.session.append('model/selection', selection);
          },
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
      if (!handle) throw new PluginError('NOT_OWNED', '当前插件不持有该临时会话，未执行关闭。');
      handle.agent.cancel({ kind: 'user' });
      await handle.agent.whenIdle();
      await handle.dispose();
      handles.delete(sessionId);
      temporary.forget(sessionId);
    },
  };
}

const initializers = [];
export class CodexSidechatHost extends TypertRemoteService {
  static inject = HOST_INJECT;
  constructor(ctx, temporary) {
    super(ctx, 'codexSidechatHost', { namespace: 'codexSidechat' });
    for (const initialize of initializers) initialize.call(this);
    this.core = new SidechatServiceCore({ sessions: createSessionAdapter(ctx, temporary), uuid: randomUUID });
    ctx.effect(() => () => this.core.dispose(), 'codex-sidechat: temporary lifetime');
  }
  async list(request) { return this.invoke('list', request); }
  async open(request) { return this.invoke('open', request); }
  async discard(request) { return this.invoke('discard', request); }
  async update() { throw new RemoteError('codex-sidechat/ephemeral', '临时侧聊不能重命名或恢复已丢弃的记录。', {}); }
  async save() { throw new RemoteError('codex-sidechat/ephemeral', '临时侧聊不能另存为正式会话；可将所需结论带回主对话。', {}); }
  async invoke(method, request) {
    try {
      const value = await this.core[method](request);
      if (method === 'open') return this.present(value);
      if (method === 'list') return value.map(record => this.present(record));
      return value;
    }
    catch (error) { if (!(error instanceof PluginError)) throw error; throw new RemoteError(`codex-sidechat/${error.code.toLowerCase().replaceAll('_', '-')}`, error.message, {}); }
  }
  present(record) {
    const session = this.ctx.sessions.get(record.sessionId);
    if (!session) throw new PluginError('SIDECHAT_NOT_FOUND', '该临时会话已释放，请重新打开侧聊。');
    return { ...record, summary: {
      sessionId: record.sessionId, updatedAt: session.snapshotEvents().at(-1)?.time ?? record.createdAt,
      running: this.ctx.agents.get(record.sessionId)?.status === 'running', agentAvailable: true,
      blank: false, formatStatus: 'current', parentSessionId: record.parentId,
      ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
    } };
  }
}
for (const method of ['list', 'open', 'discard', 'update', 'save']) {
  Remote({ name: method, resources: { session: request => request.parentId } })(CodexSidechatHost.prototype[method], { kind: 'method', name: method, static: false, private: false, addInitializer: initialize => initializers.push(initialize) });
}

export function apply(ctx) {
  const temporary = ctx.sessionPersistence.temporary;
  if (!temporary) throw new Error('DSH Sidechat requires its bundled persistence adapter.');
  new CodexSidechatHost(ctx, temporary);
}
