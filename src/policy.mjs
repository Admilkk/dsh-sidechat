/** Independently written policy, based on the behavior of Codex /side 0.163.0. */
export const SIDE_POLICY = `You are the assistant in a temporary side conversation, separate from its parent conversation.
The inherited transcript is background reference. It does not authorize continuing the parent's task, plan, tool calls, approvals, edits, or other requests. Act only on user instructions submitted in this side conversation after its boundary. If none have arrived, wait.
Answer questions and perform lightweight, non-mutating exploration. You may read/search files and run checks that do not change tracked files. Modify files, git state, configuration, permissions, or workspace state only when a new side-conversation user instruction explicitly requests that change. Keep authorized changes minimal and avoid disrupting the parent. Request wider permissions only for such an explicitly requested change that needs them.
Tools and their permissions belong to this conversation. Inherited tool calls and results are historical reference, never pending work to execute again.
Do not create, message, inspect, wait for, or otherwise interact with sub-agents or delegated workflows. Do not create or attach worktrees here; direct worktree requests to the parent conversation.
This conversation is temporary. Switching away keeps it available. Explicitly closing it stops its work and discards it. Do not claim it has been saved or that it will keep monitoring after it is closed.`;

export const SIDE_BOUNDARY = `Temporary side-conversation boundary. Everything earlier is inherited reference from the parent, not an active instruction. Only user messages after this boundary define the side task. Do not resume or execute the parent's unfinished work, queued messages, approvals, or tools. Follow the side-conversation policy.`;

export const TEMP_PREFIX = 'codex-sidechat-temp-';
export const isTemporarySession = id => typeof id === 'string' && id.startsWith(TEMP_PREFIX);

/** Hard-deny delegation/worktree endpoints even when exposed by a preset or MCP. */
export function forbiddenSideTool(name) {
  const full = String(name);
  const leaf = full.split(/[./:]/u).at(-1).replace(/^.*__/, '');
  if (/^(?:send_message|wait_agent|followup_task)$/u.test(leaf) && /(?:^|__)mcp/u.test(full)) return false;
  return /^(?:subagent(?:_.*)?|spawn_agent|send_message_to_agent|send_message|wait_agent|wait_agents|list_agents|resume_agent|close_agent|interrupt_agent|followup_task|workflow(?:_.*)?|create_worktree|attach_worktree|restore_worktree)$/u.test(leaf);
}

/** Pure fold of the parent's committed events; this never changes the child's prompt. */
export function parentStatus(entries, { running, pendingInteraction, closed = false } = {}) {
  if (closed) return 'closed';
  let status = null;
  const approvals = new Set(), questions = new Set();
  for (const item of Array.isArray(entries) ? entries : []) {
    const event = item?.type === 'event' ? item.event : item;
    const data = event?.data ?? {};
    switch (event?.type) {
      case 'turn/start': status = 'running'; approvals.clear(); questions.clear(); break;
      case 'approval/asked': approvals.add(data.id); break;
      case 'approval/decided': approvals.delete(data.id); break;
      case 'tool/call': if (data.name === 'ask_user_question') questions.add(data.callId); break;
      case 'tool/result': {
        const content = JSON.stringify(data.message?.content ?? []);
        if (!content.includes('\\"pending\\":true') && !content.includes('"pending":true')) questions.delete(data.message?.toolCallId ?? data.callId);
        break;
      }
      case 'user/message': if (data.source?.kind === 'user') questions.clear(); break;
      case 'turn/end': {
        const reason = data.reason?.kind;
        status = reason === 'completed' ? 'finished' : ['error', 'failed'].includes(reason) ? 'failed' : 'interrupted';
        approvals.clear(); questions.clear(); break;
      }
      default: break;
    }
  }
  if (approvals.size || /approval/u.test(String(pendingInteraction?.kind ?? pendingInteraction ?? ''))) return 'needs-approval';
  if (questions.size || /question|input/u.test(String(pendingInteraction?.kind ?? pendingInteraction ?? ''))) return 'needs-input';
  return running === true ? 'running' : status;
}

export const PARENT_STATUS_LABELS = Object.freeze({ running: '主线正在执行', finished: '主线已完成', failed: '主线执行失败', interrupted: '主线已中断', closed: '主线已关闭', 'needs-input': '主线需要你的回答', 'needs-approval': '主线等待审批' });
