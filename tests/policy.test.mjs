import test from 'node:test';
import assert from 'node:assert/strict';
import { parentStatus, forbiddenSideTool } from '../src/policy.mjs';

const event = (type, data = {}) => ({ type: 'event', event: { type, data } });
test('parent lifecycle uses committed notifications, including failures and interruption', () => {
  assert.equal(parentStatus([]), null);
  assert.equal(parentStatus([event('turn/start')]), 'running');
  for (const [reason, expected] of [['completed', 'finished'], ['error', 'failed'], ['failed', 'failed'], ['aborted', 'interrupted'], ['forked', 'interrupted']]) {
    assert.equal(parentStatus([event('turn/start'), event('turn/end', { reason: { kind: reason } })]), expected);
  }
  assert.equal(parentStatus([], { closed: true }), 'closed');
});
test('pending approvals are tracked by identity and clear on resolution', () => {
  const events = [event('turn/start'), event('approval/asked', { id: 'a' }), event('approval/asked', { id: 'b' }), event('approval/decided', { id: 'a' })];
  assert.equal(parentStatus(events), 'needs-approval');
  assert.equal(parentStatus([...events, event('approval/decided', { id: 'b' })]), 'running');
  assert.equal(parentStatus([...events, event('turn/end', { reason: { kind: 'completed' } })]), 'finished');
});
test('question waits survive pending results and clear on answer or cancellation', () => {
  const events = [event('turn/start'), event('tool/call', { name: 'ask_user_question', callId: 'q' })];
  assert.equal(parentStatus(events), 'needs-input');
  assert.equal(parentStatus([...events, event('tool/result', { message: { toolCallId: 'q', content: [{ type: 'text', text: '{"pending":true}' }] } })]), 'needs-input');
  assert.equal(parentStatus([...events, event('tool/result', { message: { toolCallId: 'q', content: [{ type: 'text', text: 'answered' }] } })]), 'running');
  assert.equal(parentStatus([...events, event('turn/end', { reason: { kind: 'aborted' } })]), 'interrupted');
  assert.equal(parentStatus([], { pendingInteraction: 'user-question' }), 'needs-input');
});
test('native current status overrides stale completed history without touching model context', () => {
  assert.equal(parentStatus([event('turn/end', { reason: { kind: 'completed' } })], { running: true }), 'running');
  assert.equal(parentStatus(undefined), null);
  assert.equal(parentStatus([].entries), null);
});
test('delegation and worktree calls are blocked while ordinary tools remain available', () => {
  for (const name of ['subagent', 'subagent_fork', 'subagent_send_message', 'workflow', 'spawn_agent', 'collaboration.wait_agent', 'mcp__codex_app__create_worktree', 'attach_worktree']) assert.equal(forbiddenSideTool(name), true, name);
  for (const name of ['read', 'write', 'bash', 'search', 'get_goal', 'mcp__drive__search', 'mcp__slack__send_message']) assert.equal(forbiddenSideTool(name), false, name);
});
