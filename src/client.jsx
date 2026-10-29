import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import css from './client.css';
import { PLUGIN_ID, addQuote, collectReturnPairs, makeReturnItem, composePrompt, clampWidth, normalizeRecord } from './domain.mjs';
import { isTemporarySession, parentStatus, PARENT_STATUS_LABELS } from './policy.mjs';

const KIND = 'codex-sidechat';
const CONTEXT_SOURCE = 'codex-sidechat-context';
const EMPTY = Object.freeze([]);
const EMPTY_STATE = Object.freeze({ records: EMPTY, selected: null, loading: false, error: null });
const ICONS = { side: '◧', add: '+', history: '◷', close: '×', more: '···', back: '↩', quote: '❞', chevron: '⌄' };
function Icon({ name }) {
  const shapes = {
    side: <><rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M14 4v16" /></>,
    add: <path d="M12 5v14M5 12h14" />,
    history: <><circle cx="12" cy="12" r="8.5" /><path d="M12 6.5V12l4 2.5" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    more: <><circle cx="5" cy="12" r=".8" /><circle cx="12" cy="12" r=".8" /><circle cx="19" cy="12" r=".8" /></>,
    back: <><path d="m8 6-5 5 5 5M3 11h11a6 6 0 0 1 0 12" /></>,
    quote: <><path d="M5 7h5v6H6c0 3-1 4-3 5M14 7h5v6h-4c0 3-1 4-3 5" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    '✓': <path d="m5 12 4 4L19 6" />,
  };
  return shapes[name] ? <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg> : <span aria-hidden="true">{name}</span>;
}
const textBlocks = content => (Array.isArray(content) ? content : []).filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n');
const errorText = error => error?.message ?? String(error);
const timeValue = value => typeof value === 'number' ? value : Date.parse(value);

/** Gateway's Remote transport requires one args envelope around named method arguments. */
export async function callSidechat(connection, method, request, signal) {
  const value = await connection.rpc.call('/api', `codexSidechat/${method}`, { args: { request } }, signal);
  if (value?.ok === false) throw new Error(value.error?.message ?? value.error?.code ?? '操作失败');
  return value?.ok === true ? value.value : value;
}

/** Only our own source is decoded. Other native references remain opaque. */
export function decodeContext(ref) {
  try {
    const item = JSON.parse(ref);
    if (!item || !['quote', 'return'].includes(item.kind) || typeof item.id !== 'string') return null;
    if (item.kind === 'quote' && (typeof item.text !== 'string' || typeof item.sourceSessionId !== 'string')) return null;
    if (item.kind === 'return' && (typeof item.question !== 'string' || typeof item.answer !== 'string')) return null;
    return item;
  } catch { return null; }
}

/** Add a native atomic reference without rewriting existing text, chips or slash claim. */
export function attachContextDraft(draft, item) {
  const refs = Array.isArray(draft.references) ? draft.references : [];
  if (refs.some(ref => ref.source === CONTEXT_SOURCE && decodeContext(ref.ref)?.id === item.id)) return draft;
  const context = refs.filter(ref => ref.source === CONTEXT_SOURCE).map(ref => decodeContext(ref.ref)).filter(Boolean);
  const quotes = context.filter(value => value.kind === 'quote');
  const returns = context.filter(value => value.kind === 'return');
  if (item.kind === 'quote') composePrompt('', addQuote(quotes, item), returns);
  else composePrompt('', quotes, [...returns, makeReturnItem(item)]);
  const token = `[${item.kind === 'return' ? '侧聊回传' : '引用'} ${item.id.slice(-6)}]`;
  const separator = draft.text && !/\s$/u.test(draft.text) ? ' ' : '';
  const offset = draft.text.length + separator.length;
  return { ...draft, text: draft.text + separator + token + ' ', references: [...refs, {
    source: CONTEXT_SOURCE, ref: JSON.stringify(item), offset, length: token.length,
    label: item.kind === 'return' ? '侧边讨论' : (item.label ?? '选中文字'),
    appearance: 'session', clipboardText: token,
  }] };
}

/** Remove one reference span and shift later native references, preserving their identities. */
export function removeContextDraft(draft, id) {
  const target = draft.references?.find(ref => ref.source === CONTEXT_SOURCE && decodeContext(ref.ref)?.id === id);
  if (!target) return draft;
  const end = target.offset + target.length;
  return { ...draft, text: draft.text.slice(0, target.offset) + draft.text.slice(end), references: draft.references
    .filter(ref => ref !== target).map(ref => ({ ...ref, offset: ref.offset >= end ? ref.offset - target.length : ref.offset })) };
}

export function serializeContext(ref) {
  const item = decodeContext(ref);
  if (!item) throw new Error('引用已损坏，请移除该引用后重试。');
  const type = item.kind === 'return' ? '回传' : '引用';
  const token = encodeURIComponent(item.id);
  const content = item.kind === 'return' ? composePrompt('', [], [makeReturnItem(item)]) : composePrompt('', [item.annotation ? { ...item, text: `${item.text}\n\n用户批注：${item.annotation}` } : item], []);
  return `⟪侧聊${type}:${token}⟫\n${content}\n⟪/侧聊${type}:${token}⟫`;
}

/** The UI consumes this delimited plain-text reference without changing the model input. */
export function findSentContext(text, from = 0) {
  const expression = /⟪侧聊(引用|回传):([A-Za-z0-9%._~!'-]+)⟫\n/gu;
  expression.lastIndex = from;
  const match = expression.exec(text);
  if (!match) return undefined;
  const closing = `⟪/侧聊${match[1]}:${match[2]}⟫`;
  const end = text.indexOf(closing, expression.lastIndex);
  if (end < 0) return undefined;
  return { id: 'codex-sidechat-context', start: match.index, end: end + closing.length, data: { label: match[1] === '回传' ? '侧边讨论' : '引用与批注', text: text.slice(expression.lastIndex, end) } };
}

/** Normalize durable completed turns. Live streams, inherited history and tool-only steps are excluded. */
export function completedMessages(entries, record) {
  const minimum = record.boundary?.inheritedMaxSeq;
  const capturedAt = record.boundary?.capturedAt ?? record.createdAt;
  const output = [];
  let user = null;
  let assistant = null;
  const newer = event => Number.isFinite(minimum) ? event.seq > minimum : timeValue(event.time) >= timeValue(capturedAt);
  for (const entry of entries ?? []) {
    if (entry?.type !== 'event') continue;
    const event = entry.event;
    if (!event || !newer(event)) continue;
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      user = { id: String(event.data.id), role: 'user', text: textBlocks(event.data.content), complete: true, sourceSessionId: record.sessionId };
      assistant = null;
    } else if (event.type === 'assistant/message' && user && !event.data?.interrupted) {
      const text = textBlocks(event.data?.message?.content);
      if (text.trim()) assistant = { id: String(event.data.message.id), role: 'assistant', text, complete: true, channel: 'final', sourceSessionId: record.sessionId };
    } else if (event.type === 'turn/end') {
      const reason = event.data?.reason?.kind;
      if (user && assistant && reason === 'completed') output.push(user, assistant);
      user = null;
      assistant = null;
    }
  }
  return output;
}

export function inheritedTurnIds(entries, record) {
  const maximum = record.boundary?.inheritedMaxSeq;
  const capturedAt = record.boundary?.capturedAt ?? record.createdAt;
  const turns = new Set();
  for (const entry of entries ?? []) {
    if (entry?.type !== 'event') continue;
    const event = entry.event;
    const inherited = Number.isFinite(maximum) ? event.seq <= maximum : timeValue(event.time) < timeValue(capturedAt);
    if (inherited && Number.isSafeInteger(event.data?.turn) && event.data.turn >= 0) turns.add(event.data.turn);
  }
  return [...turns].sort((a, b) => a - b);
}

function Button({ icon, label, children, className = '', ...props }) {
  return <button type="button" className={`csc-button ${className}`} aria-label={label} title={label} {...props}>
    {icon && <span aria-hidden="true" className="csc-icon"><Icon name={icon} /></span>}{children}
  </button>;
}

function makeState() {
  const parents = new Map();
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    get: id => parents.get(id) ?? EMPTY_STATE,
    set(id, patch) { parents.set(id, { ...(parents.get(id) ?? EMPTY_STATE), ...patch }); emit(); },
    isChild(id) { for (const value of parents.values()) if (value.records.some(record => record.sessionId === id)) return true; return false; },
    recordFor(id) { for (const value of parents.values()) { const found = value.records.find(record => record.sessionId === id); if (found) return found; } return null; },
  };
}

function localRead(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`${PLUGIN_ID}.${key}`)) ?? fallback; } catch { return fallback; }
}
function localWrite(key, value) { try { localStorage.setItem(`${PLUGIN_ID}.${key}`, JSON.stringify(value)); } catch { /* UI preference persistence is optional. */ } }

export const inject = ['slots', 'sessions', 'sidebarRightTabs', 'sidebarRight', 'connection', 'remote', 'uiConversation', 'uiSession', 'inputTriggers', 'commandUi', 'layout'];

export function apply(ctx) {
  const store = makeState();
  const releases = [];
  const retained = new Map();
  const requests = new Map();
  const hiddenIds = new Set();
  let disposed = false;
  let currentParent = null;
  let selectionState = null;
  let selectionListeners = new Set();
  const selectionNotify = value => { selectionState = value; for (const fn of selectionListeners) fn(); };
  const useParent = id => useSyncExternalStore(store.subscribe, () => store.get(id), () => store.get(id));
  const useSelection = () => useSyncExternalStore(fn => { selectionListeners.add(fn); return () => selectionListeners.delete(fn); }, () => selectionState, () => null);
  const rpc = (method, request, signal) => callSidechat(ctx.connection, method, request, signal);
  ctx.remote.$on('api-session/removed', id => {
    const record = store.recordFor(id);
    if (record) forgetChild(record);
    if (store.get(id) !== EMPTY_STATE) store.set(id, { parentClosed: true });
  });
  ctx.remote.$on('api-session/added', summary => { if (store.get(summary.sessionId) !== EMPTY_STATE) store.set(summary.sessionId, { parentClosed: false }); });
  const receiveRecord = value => {
    const record = normalizeRecord(value);
    // A private side is intentionally absent from the ordinary baseline after reload.
    // Publish its authenticated Host summary before asking the native client to retain it.
    if (record && isTemporarySession(record.sessionId) && value.summary?.sessionId === record.sessionId) ctx.sessions.handleSessionAdded(value.summary);
    return record;
  };

  const inputShell = sessionId => {
    const shell = ctx.get('conversation')?.input?.shell(sessionId);
    if (!shell?.draftSnapshot || typeof shell.setDraft !== 'function') throw new Error('当前 DSH 缺少原生引用输入接口，本插件需要 0.2.1-rc.3。');
    if (['adjudicating', 'submitting'].includes(shell.snapshot?.phase)) throw new Error('消息正在提交，请稍后再添加引用。');
    return shell;
  };
  const retain = async sessionId => {
    if (retained.has(sessionId)) return retained.get(sessionId).promise;
    const reference = ctx.sessions.retain(sessionId, { source: PLUGIN_ID });
    const holder = { reference, promise: Promise.resolve(reference.ready).then(() => {
      if (disposed) throw new Error('插件已卸载');
      return reference;
    }) };
    retained.set(sessionId, holder);
    try { return await holder.promise; } catch (error) { retained.delete(sessionId); reference.release(); throw error; }
  };
  const attach = async (sessionId, item) => {
    await retain(sessionId);
    const shell = inputShell(sessionId);
    const draft = shell.draftSnapshot;
    const next = attachContextDraft(draft, item);
    if (next !== draft) shell.setDraft(next);
    return item;
  };
  const remove = (sessionId, id) => {
    const shell = inputShell(sessionId);
    shell.setDraft(removeContextDraft(shell.draftSnapshot, id));
  };
  const refresh = parentId => {
    if (requests.has(parentId)) return requests.get(parentId);
    store.set(parentId, { loading: true, error: null });
    const pending = rpc('list', { parentId }).then(value => {
      if (disposed) return [];
      const records = (Array.isArray(value) ? value : value.records ?? []).map(receiveRecord).filter(Boolean);
      const oldSelected = store.get(parentId).selected;
      const selected = records.some(record => record.id === oldSelected) ? oldSelected : records.find(record => record.status === 'active')?.id ?? records[0]?.id ?? null;
      for (const record of records) hiddenIds.add(record.sessionId);
      syncHidden();
      store.set(parentId, { records, selected, loading: false, error: null });
      return records;
    }).catch(error => { if (!disposed) store.set(parentId, { loading: false, error: errorText(error) }); throw error; })
      .finally(() => requests.delete(parentId));
    requests.set(parentId, pending);
    return pending;
  };
  const updateRecord = (parentId, record) => {
    if (!record) throw new Error('侧聊记录响应无效');
    hiddenIds.add(record.sessionId); syncHidden();
    const records = store.get(parentId).records.filter(item => item.id !== record.id);
    store.set(parentId, { records: [record, ...records], selected: record.id, error: null });
  };
  const openPanel = async (parentId, quote) => {
    if (!parentId) throw new Error('请先打开一个主会话。');
    currentParent = parentId;
    ctx.sidebarRight.openTab(KIND, { params: { parentId } });
    const records = await refresh(parentId);
    let record = records.find(item => item.id === store.get(parentId).selected);
    if (!record) { record = receiveRecord(await rpc('open', { parentId })); if (!record) throw new Error('侧聊创建响应无效'); updateRecord(parentId, record); }
    if (quote) await attach(record.sessionId, quote);
    return record;
  };
  const forgetChild = record => {
    const holder = retained.get(record.sessionId);
    if (holder) { holder.reference.release(); retained.delete(record.sessionId); }
    ctx.sessions.handleSessionRemoved(record.sessionId);
    hiddenIds.delete(record.sessionId); syncHidden();
    if (store.get(record.parentId).records.some(item => item.id === record.id)) {
      store.set(record.parentId, { records: [], selected: null });
      const parent = retained.get(record.parentId);
      if (parent) { parent.reference.release(); retained.delete(record.parentId); }
    }
  };
  const pairsFor = async record => {
    const reference = await retain(record.sessionId);
    const session = reference.binding.session;
    // Load the finite older window only for an explicit "bring all" action.
    let pages = 0;
    while (session.getSnapshot().hasMore && pages++ < 100) {
      const before = reference.binding.eventSource.getSnapshot().entries[0]?.event?.seq;
      await session.loadOlder();
      if (reference.binding.eventSource.getSnapshot().entries[0]?.event?.seq === before) break;
    }
    if (session.getSnapshot().hasMore) throw new Error('部分侧聊历史尚未载入，请向上加载后重试。');
    return collectReturnPairs(completedMessages(reference.binding.eventSource.getSnapshot().entries, record));
  };

  const style = document.createElement('style');
  style.dataset.codexSidechat = PLUGIN_ID;
  style.textContent = css;
  document.head.appendChild(style);
  releases.push(() => style.remove());
  const hiddenStyle = document.createElement('style');
  hiddenStyle.dataset.codexSidechatHidden = PLUGIN_ID;
  document.head.appendChild(hiddenStyle);
  function syncHidden() {
    hiddenStyle.textContent = '[data-row-key^="session:codex-sidechat-temp-"][role="treeitem"]{display:none!important}';
  }
  syncHidden();
  releases.push(() => hiddenStyle.remove());

  releases.push(ctx.inputTriggers.registerSource({
    name: CONTEXT_SOURCE, trigger: '@', showGroupTitle: false,
    candidates: async () => [], onPick: () => undefined,
    codec: { clipboardText: ref => decodeContext(ref)?.text ?? decodeContext(ref)?.answer ?? '', serialize: ref => Promise.resolve(serializeContext(ref)) },
    openReference: () => false,
  }));
  releases.push(ctx.uiConversation.userText.register({ id: 'codex-sidechat-context', order: -100, match: findSentContext }));

  function SentContext({ node }) {
    return <details className="codex-sidechat csc-sent-context"><summary>{node.data.label}</summary><div>{node.data.text}</div></details>;
  }

  function ErrorBox({ error, retry }) {
    if (!error) return null;
    return <div className="csc-error" role="alert"><span>{error}</span>{retry && <Button label="重试" onClick={retry}>重试</Button>}</div>;
  }

  function ContextRail({ sessionId, useInput }) {
    const input = useInput(value => value);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState(null);
    const entries = (input?.occurrences ?? []).filter(item => item.source === CONTEXT_SOURCE).map(item => decodeContext(item.ref)).filter(Boolean);
    if (!entries.length) return null;
    return <div className="codex-sidechat csc-context-rail" data-csc-context-session={sessionId}>
      <div className="csc-chips">{entries.map(item => <div className="csc-chip" key={item.id}>
        <button type="button" className="csc-chip-label" aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? null : item.id)}>
          <span aria-hidden="true">{item.kind === 'return' ? '↩' : '❞'}</span> {item.kind === 'return' ? '侧边讨论' : item.label ?? '引用'}
        </button>
        <Button label="移除此引用" icon="close" onClick={() => { try { remove(sessionId, item.id); } catch (failure) { setError(errorText(failure)); } }} />
        {expanded === item.id && <div className="csc-chip-preview" role="region" aria-label="引用预览">
          {item.kind === 'return' ? <><strong>问题</strong><p>{item.question}</p><strong>回答</strong><p>{item.answer}</p></> : <><blockquote>{item.text}</blockquote><label>批注<textarea value={item.annotation ?? ''} placeholder="补充你的问题或修改意见" onChange={event => {
            try {
              const shell = inputShell(sessionId); const snapshot = shell.draftSnapshot;
              shell.setDraft({ ...snapshot, references: snapshot.references.map(ref => ref.source === CONTEXT_SOURCE && decodeContext(ref.ref)?.id === item.id ? { ...ref, ref: JSON.stringify({ ...item, annotation: event.target.value }) } : ref) });
            } catch (failure) { setError(errorText(failure)); }
          }} /></label></>}
        </div>}
      </div>)}</div><ErrorBox error={error} />
    </div>;
  }

  function FixedChatView(props) { return props.renderSlot('conversation.session', { view: 'chat' }); }
  function NativeConversation(props) {
    const session = props.useSession(value => value);
    const conversation = props.useConversation(value => value);
    const active = session.running || !session.blank || conversation?.activeTargets?.size > 0;
    return <div className="csc-native" data-csc-child-session={props.sessionId}>{props.renderFactorySlot('conversation.content', {
      variant: 'embedded', phase: active ? 'active' : session.openState === 'loading' ? 'settling' : 'hero', hero: !active,
    }, { slots: { views: FixedChatView } })}</div>;
  }

  function BoundChild({ reference, record, contextOpen, SessionProvider, renderSlot }) {
    const source = reference.binding.eventSource;
    const events = useSyncExternalStore(listener => source.subscribe(listener), () => source.getSnapshot(), () => source.getSnapshot());
    const inherited = inheritedTurnIds(events.entries, record);
    const selector = `.csc-child[data-csc-session="${CSS.escape(record.sessionId)}"][data-csc-hide-inherited="true"]`;
    return <div className="csc-child" data-csc-session={record.sessionId} data-csc-hide-inherited={!contextOpen}>
      <style>{inherited.map(turn => `${selector} [data-chat-turn="${turn}"]{display:none!important}`).join('\n') + (record.boundary?.hiddenMessageId ? `\n.csc-child[data-csc-session="${CSS.escape(record.sessionId)}"] [data-chat-flow-key$="${CSS.escape(record.boundary.hiddenMessageId)}"]{display:none!important}` : '')}</style>
      <SessionProvider session={reference}>{renderSlot('codex.sidechat.conversation', {})}</SessionProvider>
    </div>;
  }

  function ChildView({ record, contextOpen, SessionProvider, renderSlot }) {
    const [state, setState] = useState({ reference: null, error: null });
    const [retry, setRetry] = useState(0);
    useEffect(() => {
      let active = true;
      setState({ reference: null, error: null });
      retain(record.sessionId).then(reference => { if (active) setState({ reference, error: null }); })
        .catch(error => { if (active) setState({ reference: null, error: errorText(error) }); });
      return () => { active = false; };
    }, [record.sessionId, retry]);
    if (state.error) return <ErrorBox error={state.error} retry={() => setRetry(value => value + 1)} />;
    if (!state.reference) return <div className="csc-loading" role="status">正在载入侧边聊天…</div>;
    return <BoundChild reference={state.reference} record={record} contextOpen={contextOpen} SessionProvider={SessionProvider} renderSlot={renderSlot} />;
  }

  function ParentStatus({ parentId }) {
    const parentState = useParent(parentId);
    const [reference, setReference] = useState(null);
    useEffect(() => {
      let active = true;
      retain(parentId).then(value => { if (active) setReference(value); }).catch(() => {});
      return () => { active = false; };
    }, [parentId]);
    const source = reference?.binding.eventSource;
    const events = useSyncExternalStore(listener => source?.subscribe(listener) ?? (() => {}), () => source?.getSnapshot() ?? EMPTY, () => EMPTY);
    const statuses = ctx.uiSession.sessionStatus;
    const statusMap = useSyncExternalStore(listener => statuses.subscribe(listener), () => statuses.getSnapshot(), () => statuses.getSnapshot());
    const status = parentStatus(Array.isArray(events.entries) ? events.entries : [], { ...statusMap.get(parentId), closed: parentState.parentClosed });
    return <div className="csc-parent-status" role="status" aria-live="polite" data-parent-status={status ?? 'idle'}>{PARENT_STATUS_LABELS[status] ?? '来自主对话'}</div>;
  }

  function SidePanel(props) {
    const parentId = props.sessionId;
    const { tab, sidebar } = props.useTabInfo();
    const state = useParent(parentId);
    const record = state.records[0];
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [contextOpen, setContextOpen] = useState(false);
    const [width, setWidth] = useState(() => clampWidth(localRead('width', 440), window.innerWidth));
    const root = useRef(null);
    const lastAction = useRef(null);
    useEffect(() => { currentParent = parentId; refresh(parentId).catch(() => {}); }, [parentId]);
    useEffect(() => {
      const resize = () => setWidth(value => clampWidth(value, window.innerWidth));
      window.addEventListener('resize', resize);
      return () => window.removeEventListener('resize', resize);
    }, []);
    useEffect(() => { if (tab.visible && !sidebar.fullscreen) ctx.layout.panels?.setRightbar?.(width); }, [width, tab.visible, sidebar.fullscreen]);
    const run = async action => {
      if (busy) return;
      lastAction.current = action; setBusy(true); setError(null);
      try { await action(); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
    };
    const returnToMain = () => {
      ctx.sidebarRight.close(tab.id);
      document.querySelector(`[data-conversation-session="${CSS.escape(parentId)}"] [data-composer-input=true]`)?.focus();
    };
    const discard = () => run(async () => {
      if (record) {
        await rpc('discard', { parentId, id: record.id });
        forgetChild(record);
      }
      returnToMain();
    });
    useEffect(() => {
      const closeOnControlC = event => {
        if (!tab.visible || busy || event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== 'c') return;
        if (!root.current?.contains(document.activeElement) || document.getSelection()?.toString() || document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
        const draft = record ? inputShell(record.sessionId).draftSnapshot : null;
        if (draft?.text?.trim() || draft?.references?.length) return;
        event.preventDefault(); event.stopPropagation(); discard();
      };
      document.addEventListener('keydown', closeOnControlC, true);
      return () => document.removeEventListener('keydown', closeOnControlC, true);
    }, [tab.visible, busy, record]);
    const bringAll = () => run(async () => {
      const pairs = await pairsFor(record);
      if (!pairs.length) throw new Error('还没有可回传的已完成问答。');
      await retain(parentId);
      const shell = inputShell(parentId);
      let draft = shell.draftSnapshot;
      for (const pair of pairs) draft = attachContextDraft(draft, { kind: 'return', ...makeReturnItem(pair) });
      shell.setDraft(draft);
      returnToMain();
    });
    const drag = event => {
      if (event.button !== 0) return;
      const start = event.clientX, original = width;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      const target = event.currentTarget;
      const move = next => setWidth(clampWidth(original + start - next.clientX, window.innerWidth));
      const done = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', done); target.removeEventListener('pointercancel', done); localWrite('width', root.current?.getBoundingClientRect().width ?? width); };
      target.addEventListener('pointermove', move); target.addEventListener('pointerup', done); target.addEventListener('pointercancel', done);
    };
    return <section ref={root} className="codex-sidechat csc-panel" style={{ '--csc-preferred-width': `${width}px` }} aria-label="侧边聊天" data-csc-parent={parentId}>
      <div className="csc-resizer" role="separator" aria-label="调整侧边聊天宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={drag} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); const next = clampWidth(width + (event.key === 'ArrowLeft' ? 24 : -24), window.innerWidth); setWidth(next); localWrite('width', next);
      }} />
      <header className="csc-header">
        <div className="csc-heading"><span className="csc-brand-icon" aria-hidden="true"><Icon name="side" /></span><div><strong>侧边聊天</strong><span className="csc-title">临时讨论 · 继承历史仅供参考</span></div></div>
        <div className="csc-header-actions">
          <Button label="切回主对话（保留侧聊）" icon="back" onClick={returnToMain} />
          <Button label="将整段讨论带回主对话" icon="quote" disabled={!record || busy} onClick={bringAll} />
          <Button label="关闭并丢弃侧聊" icon="close" onClick={discard} disabled={busy} />
        </div>
      </header>
      {record && <ParentStatus parentId={parentId} />}
      <ErrorBox error={error ?? state.error} retry={() => error && lastAction.current ? run(lastAction.current) : refresh(parentId).catch(() => {})} />
      {record && <div className="csc-context-card"><button type="button" onClick={() => setContextOpen(value => !value)} aria-expanded={contextOpen}><span aria-hidden="true">↳</span><span>来自主对话的上下文</span><span className={contextOpen ? 'is-open' : ''}>{ICONS.chevron}</span></button>
        {contextOpen && <div><p>创建时截取主线历史，此后的新消息不会自动加入侧聊。继承内容仅供参考，侧聊只执行你在这里新提出的请求。</p><small>捕获时间：{new Date(record.boundary?.capturedAt ?? record.createdAt).toLocaleString('zh-CN')}</small></div>}
      </div>}
      <div className="csc-body">{state.loading && !record ? <div className="csc-loading" role="status">正在获取侧聊…</div> : record ? <ChildView key={record.sessionId} record={record} contextOpen={contextOpen} SessionProvider={props.SessionProvider} renderSlot={props.renderSlot} /> : <div className="csc-empty"><strong>临时侧边讨论</strong><button type="button" disabled={busy} onClick={() => run(() => openPanel(parentId))}>打开侧边聊天</button></div>}</div>
      <footer className="csc-footer"><span>切换保留 · 关闭丢弃</span><kbd>Alt S</kbd><span>主线 / 侧聊</span></footer>
    </section>;
  }

  function OpenAction({ sessionId }) {
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    if (isTemporarySession(sessionId) || store.isChild(sessionId)) return null;
    return <div className="codex-sidechat csc-open-action"><Button label="打开侧边聊天" icon="side" disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await openPanel(sessionId); } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); } }}>侧边聊天</Button>{error && <span role="alert" className="csc-inline-error">{error}</span>}</div>;
  }

  function ReturnAction({ sessionId, messageId }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [added, setAdded] = useState(false);
    useSyncExternalStore(store.subscribe, () => store.recordFor(sessionId), () => null);
    const record = store.recordFor(sessionId);
    const source = ctx.sessions.binding(sessionId)?.eventSource;
    const events = useSyncExternalStore(listener => source?.subscribe(listener) ?? (() => {}), () => source?.getSnapshot() ?? EMPTY, () => EMPTY);
    const pair = record ? collectReturnPairs(completedMessages(Array.isArray(events.entries) ? events.entries : [], record)).find(item => item.assistantMessageId === messageId) : null;
    if (!record || !pair) return null;
    return <span className="codex-sidechat csc-return-action"><Button label="将这组问答带回主对话" icon={added ? '✓' : 'back'} disabled={busy} onClick={async () => {
      setBusy(true); setError(null);
      try { await attach(record.parentId, { kind: 'return', ...makeReturnItem(pair) }); setAdded(true); }
      catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
    }} />{error && <span role="alert" className="csc-inline-error">{error}</span>}</span>;
  }

  function SelectionToolbar() {
    const selection = useSelection();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    if (!selection) return null;
    const act = async side => {
      setBusy(true); setError(null);
      try {
        const quote = { kind: 'quote', ...addQuote([], { text: selection.text, sourceSessionId: selection.sessionId, sourceMessageId: selection.messageId, label: '选中文字' })[0] };
        if (side) await openPanel(store.recordFor(selection.sessionId)?.parentId ?? selection.sessionId, quote);
        else await attach(selection.sessionId, quote);
        selectionNotify(null);
      } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
    };
    return <div className="codex-sidechat csc-selection-toolbar" style={{ left: selection.left, top: selection.top }} role="toolbar" aria-label="选中文字操作" onPointerDown={event => event.preventDefault()}>
      <Button label="添加到对话" icon="quote" disabled={busy} onClick={() => act(false)}>添加到对话</Button><span className="csc-toolbar-divider" />
      <Button label="在侧边聊天中提问" icon="side" disabled={busy} onClick={() => act(true)}>在侧边聊天中提问</Button>
      <Button label="关闭选区操作" icon="close" onClick={() => selectionNotify(null)} />{error && <span className="csc-selection-error" role="alert">{error}</span>}
    </div>;
  }

  releases.push(ctx.sidebarRightTabs.register({ id: PLUGIN_ID, kind: KIND, priority: 'extension', title: () => '侧边聊天', keepMounted: true,
    guide: [{ id: 'open', title: () => '侧边聊天', description: () => '在主任务旁展开独立讨论' }],
  }));
  releases.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: PLUGIN_ID,
    children: { 'codex.sidechat.conversation': { kind: 'single', scope: 'session' } },
  }, SidePanel)));
  releases.push(ctx.slots.inject('codex.sidechat.conversation', () => ctx.slots.register({ name: 'codex.sidechat.conversation' }, NativeConversation)));
  releases.push(ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities', id: PLUGIN_ID, order: 60 }, OpenAction)));
  releases.push(ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: `${PLUGIN_ID}.context`, order: -100 }, ContextRail)));
  releases.push(ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: `${PLUGIN_ID}.return`, order: 80 }, ReturnAction)));
  releases.push(ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({ name: 'conversation.user.text.node', key: 'codex-sidechat-context' }, SentContext)));
  releases.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: `${PLUGIN_ID}.selection`, order: 90 }, SelectionToolbar)));

  const inspectSelection = () => {
    if (disposed) return;
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return selectionNotify(null);
    const range = selection.getRangeAt(0);
    const element = node => node?.nodeType === 1 ? node : node?.parentElement;
    const start = element(range.startContainer), end = element(range.endContainer);
    if (!start || !end || start.closest('input,textarea,[contenteditable],.csc-chip-preview,.csc-selection-toolbar')) return selectionNotify(null);
    const row = start.closest('[data-chat-flow-key]');
    if (!row || row !== end.closest('[data-chat-flow-key]') || !['assistant-step', 'user'].includes(row.dataset.chatFlowKind)) return selectionNotify(null);
    const scope = start.closest('[data-csc-child-session]') ?? start.closest('[data-conversation-session]');
    const sessionId = scope?.dataset.cscChildSession ?? scope?.dataset.conversationSession ?? ctx.sidebarRight.mounted?.getSnapshot?.();
    if (!sessionId) return selectionNotify(null);
    const text = selection.toString();
    if (!text.trim() || text.length > 65536) return selectionNotify(null);
    const rect = range.getBoundingClientRect();
    selectionNotify({ text, sessionId, messageId: row.dataset.chatFlowKey, left: Math.max(8, Math.min(rect.left + rect.width / 2 - 160, window.innerWidth - 360)), top: Math.max(8, rect.top - 44) });
  };
  document.addEventListener('pointerup', inspectSelection);
  document.addEventListener('keyup', inspectSelection);
  const escape = event => {
    if (event.key === 'Escape' && selectionState) selectionNotify(null);
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 's') {
      const visible = element => Boolean(element?.getClientRects().length);
      const pane = [...document.querySelectorAll('.csc-panel')].find(visible);
      const main = [...document.querySelectorAll('[data-conversation-session]')].find(element => visible(element) && !element.closest('.csc-panel') && !isTemporarySession(element.dataset.conversationSession));
      const parentId = main?.dataset.conversationSession;
      if (!parentId) return;
      event.preventDefault();
      if (pane && pane.contains(document.activeElement) && pane.dataset.cscParent === parentId) main.querySelector('[data-composer-input=true]')?.focus();
      else openPanel(parentId).then(() => {
        const target = [...document.querySelectorAll('.csc-panel')].find(element => visible(element) && element.dataset.cscParent === parentId);
        target?.querySelector('[data-composer-input=true]')?.focus();
      }).catch(error => store.set(parentId, { error: errorText(error) }));
    }
  };
  document.addEventListener('keydown', escape);
  releases.push(() => { document.removeEventListener('pointerup', inspectSelection); document.removeEventListener('keyup', inspectSelection); document.removeEventListener('keydown', escape); });

  // Use host command registration if present; the ordinary header/selection paths do not depend on it.
  const commands = ctx.get('commandUi');
  if (typeof commands?.register === 'function') {
    try { releases.push(commands.register({ name: 'side', description: () => '打开侧边聊天', available: session => !isTemporarySession(session.sessionId) && !store.isChild(session.sessionId), ui: { kind: 'action', run: session => { openPanel(session.sessionId).catch(error => store.set(session.sessionId, { error: errorText(error) })); } } })); }
    catch (error) { console.warn(`[${PLUGIN_ID}] /side registration unavailable`, error); }
  }
  ctx.effect(() => () => {
    disposed = true;
    selectionListeners.clear();
    for (const release of releases.reverse()) { try { if (typeof release === 'function') release(); } catch (error) { console.error(`[${PLUGIN_ID}] cleanup`, error); } }
    for (const { reference } of retained.values()) reference.release();
    retained.clear();
  }, `${PLUGIN_ID}: client lifecycle`);
}
