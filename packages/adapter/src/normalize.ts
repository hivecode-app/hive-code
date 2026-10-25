// stream-json (CLI stdout) -> EngineEvent. The only place that knows the wire shapes.
// Unknown shapes become `other` (never dropped, never fatal).
import type { EngineEvent } from '@company/shared';

type J = Record<string, any>;

export interface LifecycleSignal {
  commandUuid: string;
  state: string;           // queued | started | completed | cancelled | ...
}

export interface ControlResponse {
  requestId: string;
  ok: boolean;
  response?: unknown;
  error?: string;
}

export interface Normalized {
  events: EngineEvent[];
  lifecycle?: LifecycleSignal;
  control?: ControlResponse;
  /** CLI -> host control_request (e.g. can_use_tool); host must answer. */
  inboundControl?: { requestId: string; subtype: string; request: J };
}

const preview = (v: unknown, n = 400): string => {
  const s = typeof v === 'string' ? v
    : Array.isArray(v) ? v.map((b: J) => (typeof b?.text === 'string' ? b.text : '')).join('')
      : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b: J) => b?.type === 'text').map((b: J) => b.text).join('') : '';

/**
 * Per-process stream state. Deltas carry no message id on the wire; the id arrives once in `message_start`.
 * Stamping it on every delta lets a client grow the bubble that the final `text` (same messageId) replaces,
 * instead of a second bubble (chat.md §2.3א: one reply, one bubble).
 */
export interface StreamState { messageId?: string }

export function normalize(o: J, st: StreamState = {}): Normalized {
  const type = o?.type;
  const ev: EngineEvent[] = [];
  switch (type) {
    case 'system': {
      const st = o.subtype;
      if (st === 'init') {
        ev.push({ kind: 'init', sessionId: o.session_id, model: o.model, cwd: o.cwd, tools: o.tools ?? [],
          permissionMode: o.permissionMode, messagingSocketPath: o.messaging_socket_path,
          memoryPaths: o.memory_paths, version: o.claude_code_version });
      } else if (st === 'compact_boundary') {
        const m = o.compact_metadata ?? o.compactMetadata ?? {};
        ev.push({ kind: 'compact', trigger: m.trigger, preTokens: m.pre_tokens ?? m.preTokens,
          postTokens: m.post_tokens ?? m.postTokens });
      } else if (st === 'status') {
        ev.push({ kind: 'status', status: o.status ?? null });
      } else if (st === 'hook_started' || st === 'hook_response') {
        ev.push({ kind: 'hook', phase: st === 'hook_started' ? 'started' : 'response',
          event: o.hook_event ?? o.hook_event_name ?? '', name: o.hook_name, outcome: o.outcome });
      } else if (st === 'peer_message_hold') {
        ev.push({ kind: 'peer_hold', state: o.state, cause: o.cause, lane: o.lane });
      } else {
        ev.push({ kind: 'other', type, subtype: st, raw: o });
      }
      return { events: ev };
    }
    case 'stream_event': {
      const e = o.event ?? {};
      // Subagent streams interleave with the main one; only the main conversation's id is tracked.
      if (e.type === 'message_start' && !o.parent_tool_use_id) st.messageId = e.message?.id ?? undefined;
      if (e.type === 'content_block_delta') {
        const d = e.delta ?? {};
        const mid = o.parent_tool_use_id ? {} : st.messageId ? { messageId: st.messageId } : {};
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          return { events: [{ kind: 'text_delta', text: d.text, ...mid }] };
        }
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          return { events: [{ kind: 'thinking_delta', text: d.thinking, ...mid }] };
        }
      }
      return { events: [] };   // message_stop etc. carry nothing we need
    }
    case 'assistant': {
      const m = o.message ?? {};
      for (const b of (Array.isArray(m.content) ? m.content : []) as J[]) {
        if (b.type === 'text') {
          ev.push({ kind: 'text', text: b.text, messageId: m.id, ...(o.parent_tool_use_id ? { parentToolUseId: o.parent_tool_use_id } : {}) });
        }
        else if (b.type === 'tool_use') {
          ev.push({ kind: 'tool_use', toolUseId: b.id, name: b.name, input: b.input,
            parentToolUseId: o.parent_tool_use_id ?? undefined });
        }
      }
      return { events: ev };
    }
    case 'user': {
      const m = o.message ?? {};
      if (o.isReplay === true) {
        return { events: [{ kind: 'user_echo', uuid: o.uuid, text: textOf(m.content) }] };
      }
      for (const b of (Array.isArray(m.content) ? m.content : []) as J[]) {
        if (b.type === 'tool_result') {
          ev.push({ kind: 'tool_result', toolUseId: b.tool_use_id, isError: b.is_error === true, preview: preview(b.content) });
        }
      }
      if (!ev.length) ev.push({ kind: 'other', type, raw: o });
      return { events: ev };
    }
    case 'result': {
      const mu = o.modelUsage ?? {};
      const cw = Object.values(mu).map((x: any) => x?.contextWindow).find((x) => typeof x === 'number');
      ev.push({ kind: 'result', subtype: o.subtype, isError: o.is_error === true, text: o.result,
        numTurns: o.num_turns, costUsd: o.total_cost_usd, durationMs: o.duration_ms, usage: o.usage,
        contextWindow: cw as number | undefined, permissionDenials: o.permission_denials });
      return { events: ev };
    }
    case 'rate_limit_event': {
      const r = o.rate_limit_info ?? {};
      const w = r.unifiedWindows ?? {};
      ev.push({ kind: 'rate_limit', status: r.status, rateLimitType: r.rateLimitType, resetsAt: r.resetsAt,
        fiveHour: w.five_hour?.utilization, sevenDay: w.seven_day?.utilization });
      return { events: ev };
    }
    case 'command_lifecycle':
      return { events: [], lifecycle: { commandUuid: o.command_uuid, state: o.state } };
    case 'control_response': {
      const r = o.response ?? {};
      return { events: [], control: { requestId: r.request_id, ok: r.subtype === 'success',
        response: r.response, error: r.error } };
    }
    case 'control_request':
      return { events: [], inboundControl: { requestId: o.request_id, subtype: o.request?.subtype, request: o.request ?? {} } };
    default:
      return { events: [{ kind: 'other', type: String(type), subtype: o?.subtype, raw: o }] };
  }
}
