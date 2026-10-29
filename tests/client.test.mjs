import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(process.env.DSH_BUILD_TOOLS ? path.resolve(process.env.DSH_BUILD_TOOLS, 'package.json') : import.meta.url);
const { build } = require('esbuild');
const result = await build({
  entryPoints: [path.join(root, 'src/client.jsx')], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
  loader: { '.css': 'text' }, logLevel: 'silent',
  plugins: [{ name: 'pure-client-projection-test', setup(builder) {
    builder.onResolve({ filter: /^react(\/.*)?$/ }, args => ({ path: args.path, namespace: 'test-react' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-react' }, () => ({ contents: 'export default {}; export const useEffect=()=>{},useRef=()=>{},useState=()=>{},useSyncExternalStore=()=>{},jsx=()=>{},jsxs=()=>{},Fragment=null;' }));
  } }],
});
const client = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const { attachContextDraft, removeContextDraft, serializeContext, decodeContext, completedMessages, findSentContext, callSidechat, inheritedTurnIds } = client;
const quote = { kind: 'quote', id: 'quote-fixture', text: '第一行\n第二行 <b>仅为文字</b>', sourceSessionId: 'parent', label: '设计说明' };

test('Remote call uses the real gateway args envelope and unwraps results and failures', async () => {
  const request = { parentId: 'parent' };
  const controller = new AbortController();
  const calls = [];
  const connection = { rpc: { call: async (...args) => { calls.push(args); return { ok: true, value: [] }; } } };
  assert.deepEqual(await callSidechat(connection, 'list', request, controller.signal), []);
  assert.deepEqual(calls[0], ['/api', 'codexSidechat/list', { args: { request } }, controller.signal]);
  await assert.rejects(callSidechat({ rpc: { call: async () => ({ ok: false, error: { message: '真实错误' } }) } }, 'list', request), /真实错误/u);
});

test('native context attachment preserves preexisting text, file chips and command claim', () => {
  const draft = { text: '/plan @a.txt 修改方案', command: { token: '/plan' }, references: [{ source: 'reference', ref: '@a.txt', offset: 6, length: 6, label: 'a.txt', clipboardText: '@a.txt', appearance: 'file' }] };
  const next = attachContextDraft(draft, quote);
  assert.equal(next.text.slice(0, draft.text.length), draft.text);
  assert.deepEqual(next.references[0], draft.references[0]);
  assert.deepEqual(next.command, draft.command);
  const attached = next.references[1];
  assert.equal(next.text.slice(attached.offset, attached.offset + attached.length), attached.clipboardText);
  assert.equal(decodeContext(attached.ref).text, quote.text);
  assert.equal(draft.references.length, 1);
  assert.equal(attachContextDraft(next, quote), next, 'same result is never duplicated');
});

test('removing a context chip adjusts all later native offsets without altering their payloads', () => {
  const first = attachContextDraft({ text: '保留正文', references: [] }, quote);
  const second = attachContextDraft(first, { ...quote, id: 'quote-second', text: '另一个问题' });
  const tail = '@file';
  const draft = { ...second, text: second.text + tail, references: [...second.references, { source: 'reference', ref: tail, offset: second.text.length, length: tail.length, clipboardText: tail, label: 'file' }] };
  const next = removeContextDraft(draft, quote.id);
  assert.equal(next.references.length, 2);
  for (const ref of next.references) assert.equal(next.text.slice(ref.offset, ref.offset + ref.length), ref.clipboardText);
  assert.equal(next.references[1].ref, '@file');
  assert.equal(next.text.startsWith('保留正文'), true);
  assert.equal(removeContextDraft(next, 'not-present'), next);
});

test('native context attachments enforce combined limits before modifying a draft', () => {
  let draft = { text: '仍保留', references: [] };
  for (let index = 0; index < 32; index += 1) draft = attachContextDraft(draft, { ...quote, id: `quote-${index}`, text: `引用 ${index}` });
  assert.throws(() => attachContextDraft(draft, { ...quote, id: 'quote-overflow', text: '第33条' }), /at most 32/u);
  assert.equal(draft.references.length, 32);
  assert.equal(draft.text.startsWith('仍保留'), true);
});

test('reference codec preserves exact text and annotation while model input remains plain text', () => {
  const serialized = serializeContext(JSON.stringify({ ...quote, annotation: '请解释第 2 行' }));
  assert.ok(serialized.includes(quote.text.split('\n')[0]));
  assert.ok(serialized.includes('<b>仅为文字</b>'));
  assert.ok(serialized.includes('请解释第 2 行'));
  const projected = findSentContext('正文\n' + serialized + '\n后续问题');
  assert.equal(projected.start, 3);
  assert.equal(projected.data.label, '引用与批注');
  assert.equal(('正文\n' + serialized).slice(projected.start, projected.end), serialized);
  assert.equal(findSentContext('普通正文'), undefined);
  assert.throws(() => serializeContext('{broken'), /引用已损坏/u);
});

const event = (seq, type, data) => ({ type: 'event', event: { seq, time: 1000 + seq, type, data } });
const user = (seq, id, text) => event(seq, 'user/message', { id, source: { kind: 'user' }, content: [{ type: 'text', text }] });
const assistant = (seq, id, text) => event(seq, 'assistant/message', { message: { id, content: [{ type: 'text', text }] } });

test('only new successful final question-answer pairs are returnable after native fork closers', () => {
  const record = { sessionId: 'child', createdAt: 0, boundary: { inheritedMaxSeq: 10 } };
  const entries = [user(1, 'old-user', '继承问题'), assistant(8, 'old-answer', '继承答案'),
    event(11, 'step/end', { reason: { kind: 'forked' } }), event(12, 'turn/end', { reason: { kind: 'forked' } }),
    user(13, 'new-user', '侧聊问题'), assistant(14, 'commentary', '中间说明'), assistant(15, 'answer', '最终答案'), event(16, 'turn/end', { reason: { kind: 'completed' } }),
    user(17, 'stopped-user', '中止问题'), assistant(18, 'stopped-answer', '不完整答案'), event(19, 'turn/end', { reason: { kind: 'aborted' } }),
    user(20, 'running-user', '仍在运行'), assistant(21, 'running-answer', '尚未完成'),
    { type: 'transient', event: { seq: 22, type: 'assistant/live-chunk', data: { text: '不采纳' } } }];
  const messages = completedMessages(entries, record);
  assert.deepEqual(messages.map(message => message.id), ['new-user', 'answer']);
  assert.equal(messages[1].text, '最终答案');
});

test('unknown turn endings and failed turns never become successful side-chat results', () => {
  for (const reason of ['error', 'max-tokens', 'interrupted', 'blocked', 'stop', 'future-reason']) {
    const messages = completedMessages([user(2, 'u', '问题'), assistant(3, 'a', '答案'), event(4, 'turn/end', { reason: { kind: reason } })], { sessionId: 'child', boundary: { inheritedMaxSeq: 1 } });
    assert.deepEqual(messages, [], reason);
  }
});

test('inherited context folding targets only real inherited turns and never a child turn', () => {
  const entries = [event(1, 'turn/start', { turn: 1 }), event(10, 'step/start', { turn: 2 }),
    event(11, 'turn/end', { turn: 2, reason: { kind: 'forked' } }), event(12, 'turn/start', { turn: 3 })];
  assert.deepEqual(inheritedTurnIds(entries, { boundary: { inheritedMaxSeq: 10 } }), [1, 2]);
  assert.deepEqual(inheritedTurnIds(entries, { createdAt: 1011 }), [1, 2]);
});
