/**
 * Session Monitor sidecar backend.
 *
 * Read-only monitor for the active conversation's transcript.jsonl:
 *   <appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *
 * Computes live context length, per-model token usage, cache hit rates,
 * historical output TPS, full filterable/paginated activity history,
 * Codex-style scrubber ticks, and on-demand full step inspection.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const COMPACTION_REF_TOKENS = 500_000;
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const ALL_KINDS = ['user', 'summary', 'progress', 'async', 'compact', 'thought', 'tool'];
const BG_TASK_RE = /background task with task id:\s*([0-9a-f-]+(?:\/[a-z0-9_-]+)?)/i;
const SUBAGENT_ID_RE = /Created the following subagent:[\s\S]*?"conversationId"\s*:\s*"([0-9a-f-]+)"/i;
const MSG_SENDER_RE = /\[Message\][^\n]*\bsender=([0-9a-f-]+(?:\/[a-z0-9_-]+)?)/i;

function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  try {
    return readdirSync(root)
      .sort()
      .map((name) => join(root, name))
      .filter((c) => existsSync(join(c, 'brain')));
  } catch {
    return [];
  }
}

function resolveTranscriptPath(convId, full = false) {
  const candidates = full
    ? ['transcript_full.jsonl', 'transcript.jsonl']
    : ['transcript_full.jsonl', 'transcript.jsonl'];
  for (const appData of findAppDataDirs()) {
    for (const fname of candidates) {
      const p = join(appData, 'brain', convId, '.system_generated', 'logs', fname);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function summarizeTools(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return [];
  const items = [];
  for (const tc of toolCalls) {
    const name = String(tc?.name || '');
    const args = tc?.args || {};
    if (name === 'read_file' || name === 'edit_file' || name === 'write_file') {
      const raw = String(args.Path || '').replace(/^"|"$/g, '');
      const base = raw ? basename(raw) : '';
      items.push(base ? `${name.replace('_file', '')} ${base}` : name);
    } else if (name === 'run_command') {
      const summary = String(args.toolSummary || '').replace(/^"|"$/g, '').trim();
      items.push(summary || 'run_command');
    } else if (name) {
      items.push(name);
    }
  }
  return [...new Set(items)];
}

function firstThoughtLine(thinking) {
  if (!thinking || typeof thinking !== 'string') return { preview: '', truncated: false };
  let first = '';
  let nonEmptyLines = 0;
  for (const raw of thinking.split('\n')) {
    const ln = raw.trim().replace(/^#+\s*/, '').replace(/^\*+|\*+$/g, '').trim();
    if (!ln || ln.length < 4) continue;
    nonEmptyLines += 1;
    if (!first) first = ln;
  }
  if (!first) return { preview: '', truncated: false };
  const clipped = first.length > 160;
  return {
    preview: clipped ? `${first.slice(0, 159)}…` : first,
    truncated: clipped || nonEmptyLines > 1,
  };
}

function cleanUserPrompt(content, maxLen = 160) {
  if (!content || typeof content !== 'string') return { preview: '', full: '', truncated: false };
  const full = content
    .replace(/<USER_REQUEST>/gi, '')
    .replace(/<\/USER_REQUEST>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*/i, '')
    .trim();
  const single = full.replace(/\s+/g, ' ');
  const clipped = single.length > maxLen;
  return {
    preview: clipped ? `${single.slice(0, maxLen - 1)}…` : single,
    full,
    truncated: clipped || full.includes('\n'),
  };
}

function createEmptyComp() {
  return {
    firstInputTokens: null,
    initialCharsBeforeFirstCall: 0,
    systemChars: 0,
    userChars: 0,
    assistantChars: 0,
    thinkingChars: 0,
    toolCallChars: 0,
    toolResultChars: 0,
  };
}

function createEmptyAcc() {
  return {
    offset: 0,
    remainderBuf: Buffer.alloc(0),
    mtimeMs: 0,
    size: 0,
    firstAt: null,
    lastAt: null,
    lastUserAt: null,
    userTurns: 0,
    checkpoints: 0,
    lastContextInput: 0,
    lastContextOutput: 0,
    lastContextModel: null,
    lastContextStep: null,
    lastPlannerModel: null,
    prevModel: null,
    pendingTps: null, // { modelName, outputTokens, startMs }
    comp: createEmptyComp(),
    models: new Map(), // name -> { steps, uncached, cacheRead, output, maxContext, tpsOutput, tpsSeconds, tpsSamples }
    sameModel: { count: 0, uncached: 0, cacheRead: 0 },
    switches: { count: 0, uncached: 0, cacheRead: 0 },
    kindCounts: { user: 0, summary: 0, progress: 0, async: 0, compact: 0, thought: 0, tool: 0 },
    pendingAsyncIds: new Set(), // Active background tasks & subagents awaiting wakeup SYSTEM_MESSAGE
    turnIndex: -1,
    turns: [], // { turnIndex, stepIndex, createdAt, prompt, replyPreview, replyPriority }
    events: [], // all feed events in chronological order
    stepIndexMap: new Map(), // stepIndex -> { byteOffset, byteLength }
  };
}

function getOrCreateModel(acc, name) {
  let m = acc.models.get(name);
  if (!m) {
    m = { name, steps: 0, uncached: 0, cacheRead: 0, output: 0, maxContext: 0, tpsOutput: 0, tpsSeconds: 0, tpsSamples: 0 };
    acc.models.set(name, m);
  }
  return m;
}

function parseTsMs(iso) {
  if (!iso || typeof iso !== 'string') return NaN;
  return Date.parse(iso);
}

function ingestEvent(acc, ev, byteOffset, byteLength) {
  if (!ev || typeof ev !== 'object') return;
  if (ev.step_index !== undefined && byteOffset >= 0 && byteLength > 0) {
    acc.stepIndexMap.set(ev.step_index, { byteOffset, byteLength });
  }

  const ts = ev.created_at || null;
  const tsMs = parseTsMs(ts);
  if (ts) {
    if (!acc.firstAt) acc.firstAt = ts;
    acc.lastAt = ts;
  }

  // Close out pending historical TPS measurement using the immediately following tool step's start timestamp
  if (acc.pendingTps) {
    const p = acc.pendingTps;
    acc.pendingTps = null;
    if (
      ev.source === 'MODEL' &&
      ev.type !== 'PLANNER_RESPONSE' &&
      ev.type !== 'CHECKPOINT' &&
      Number.isFinite(tsMs)
    ) {
      const dtSec = (tsMs - p.startMs) / 1000;
      if (dtSec > 0 && dtSec <= 600) {
        const pm = getOrCreateModel(acc, p.modelName);
        pm.tpsOutput += p.outputTokens;
        pm.tpsSeconds += dtSec;
        pm.tpsSamples += 1;
      }
    }
  }

  const type = ev.type;
  if (type === 'USER_INPUT') {
    acc.userTurns += 1;
    acc.turnIndex += 1;
    acc.pendingAsyncIds.clear();
    if (ts) acc.lastUserAt = ts;
    const rawUserLen = (typeof ev.content === 'string' ? ev.content.length : 0) +
      (Array.isArray(ev.media) ? ev.media.length * 1200 : 0);
    acc.comp.userChars += rawUserLen;
    if (acc.comp.firstInputTokens === null) acc.comp.initialCharsBeforeFirstCall += rawUserLen;
    const { preview, truncated } = cleanUserPrompt(ev.content);
    acc.turns.push({
      turnIndex: acc.turnIndex,
      stepIndex: ev.step_index,
      createdAt: ts,
      prompt: preview || '(empty prompt)',
      replyPreview: '',
      replyPriority: 0,
    });
    acc.kindCounts.user += 1;
    acc.events.push({
      stepIndex: ev.step_index,
      turnIndex: acc.turnIndex,
      type: 'USER_INPUT',
      kind: 'user',
      model: null,
      createdAt: ts,
      text: preview,
      truncated,
      hasThinking: false,
      tools: [],
      isThought: false,
      contextTokens: null,
      cacheHitRate: null,
    });
    return;
  }

  if (type === 'SYSTEM_MESSAGE' || type === 'EPHEMERAL_MESSAGE') {
    const sysContent = typeof ev.content === 'string' ? ev.content : '';
    const sysLen = sysContent.length;
    acc.comp.systemChars += sysLen;
    if (acc.comp.firstInputTokens === null) acc.comp.initialCharsBeforeFirstCall += sysLen;

    if (type === 'SYSTEM_MESSAGE') {
      if (sysContent.includes('All your subagents and background tasks have been stopped')) {
        acc.pendingAsyncIds.clear();
      } else {
        const m = MSG_SENDER_RE.exec(sysContent);
        if (m) {
          acc.pendingAsyncIds.delete(m[1]);
          // Retroactive safety net: if the immediately preceding event in the same turn was tagged
          // `summary` right before an async wakeup message, reclassify it as `async`.
          const prev = acc.events[acc.events.length - 1];
          if (prev && prev.kind === 'summary' && prev.turnIndex === Math.max(0, acc.turnIndex)) {
            prev.kind = 'async';
            acc.kindCounts.summary = Math.max(0, (acc.kindCounts.summary || 0) - 1);
            acc.kindCounts.async = (acc.kindCounts.async || 0) + 1;
          }
        }
      }
    }
    return;
  }

  const hasTokens =
    ev.input_tokens !== undefined ||
    ev.cache_read_tokens !== undefined ||
    ev.output_tokens !== undefined;

  if (!hasTokens) {
    // Tool result steps (GENERIC, etc.)
    const resContent = typeof ev.content === 'string' ? ev.content : '';
    acc.comp.toolResultChars += resContent.length;

    // Deterministically track async background tasks & subagents
    if (ev.status === 'RUNNING') {
      const bgMatch = BG_TASK_RE.exec(resContent);
      acc.pendingAsyncIds.add(bgMatch ? bgMatch[1] : `step-${ev.step_index}`);
    } else {
      const subMatch = SUBAGENT_ID_RE.exec(resContent);
      if (subMatch) acc.pendingAsyncIds.add(subMatch[1]);
    }
    return;
  }

  const isCheckpoint = type === 'CHECKPOINT';
  const modelName = ev.model || (isCheckpoint ? '<CHECKPOINT>' : '<unknown>');
  const uncached = Number(ev.input_tokens) || 0;
  const cacheRead = Number(ev.cache_read_tokens) || 0;
  const output = Number(ev.output_tokens) || 0;
  const totalIn = uncached + cacheRead;
  const hitRate = totalIn > 0 ? (cacheRead / totalIn) * 100 : 0;

  const m = getOrCreateModel(acc, modelName);
  m.steps += 1;
  m.uncached += uncached;
  m.cacheRead += cacheRead;
  m.output += output;
  if (totalIn > m.maxContext) m.maxContext = totalIn;

  if (isCheckpoint) {
    acc.checkpoints += 1;
    acc.comp = createEmptyComp();
    const ckLen = typeof ev.content === 'string' ? ev.content.length : 0;
    acc.comp.systemChars += ckLen;
    acc.comp.initialCharsBeforeFirstCall += ckLen;
  } else if (type === 'PLANNER_RESPONSE') {
    if (acc.comp.firstInputTokens === null && totalIn > 0) {
      acc.comp.firstInputTokens = totalIn;
    }
    acc.comp.assistantChars += typeof ev.content === 'string' ? ev.content.length : 0;
    acc.comp.thinkingChars += typeof ev.thinking === 'string' ? ev.thinking.length : 0;
    if (Array.isArray(ev.tool_calls) && ev.tool_calls.length > 0) {
      try {
        acc.comp.toolCallChars += JSON.stringify(ev.tool_calls).length;
      } catch {}
    }
    if (acc.prevModel) {
      if (acc.prevModel === modelName) {
        acc.sameModel.count += 1;
        acc.sameModel.uncached += uncached;
        acc.sameModel.cacheRead += cacheRead;
      } else {
        acc.switches.count += 1;
        acc.switches.uncached += uncached;
        acc.switches.cacheRead += cacheRead;
      }
    }
    acc.prevModel = modelName;
    acc.lastPlannerModel = modelName;
    acc.lastContextInput = totalIn;
    acc.lastContextOutput = output;
    acc.lastContextModel = modelName;
    acc.lastContextStep = ev.step_index;
    if (output > 0 && Array.isArray(ev.tool_calls) && ev.tool_calls.length > 0 && Number.isFinite(tsMs)) {
      acc.pendingTps = { modelName, outputTokens: output, startMs: tsMs };
    }
  }

  const visibleContent = typeof ev.content === 'string' ? ev.content.trim() : '';
  const tools = summarizeTools(ev.tool_calls);
  const thoughtInfo = firstThoughtLine(ev.thinking);
  const hasThinking = Boolean(thoughtInfo.preview);
  const hasTruncatedField = Array.isArray(ev.truncated_fields) && ev.truncated_fields.length > 0;

  let text = '';
  let isThought = false;
  let truncated = hasTruncatedField;
  let kind = 'tool';
  if (isCheckpoint) {
    text = `Context compacted (${Math.round(totalIn / 1000)}K → ~38K tokens)`;
    kind = 'compact';
    truncated = Boolean(visibleContent);
  } else if (visibleContent) {
    const clean = visibleContent.replace(/\s+/g, ' ');
    const clipped = clean.length > 220;
    text = clipped ? `${clean.slice(0, 219)}…` : clean;
    truncated = clipped || visibleContent.includes('\n') || hasThinking || hasTruncatedField;
    if (tools.length > 0) {
      kind = 'progress';
    } else if (acc.pendingAsyncIds.size > 0) {
      kind = 'async';
    } else {
      kind = 'summary';
    }
  } else if (thoughtInfo.preview) {
    text = thoughtInfo.preview;
    isThought = true;
    truncated = thoughtInfo.truncated || hasTruncatedField;
    kind = 'thought';
  } else if (tools.length > 4) {
    truncated = true;
  }

  acc.kindCounts[kind] = (acc.kindCounts[kind] || 0) + 1;
  const curTurn = acc.turnIndex >= 0 ? acc.turns[acc.turnIndex] : null;
  if (curTurn && text) {
    // Prefer summary (3) > progress (2) > thought (1) for the turn's hover preview
    const prio = kind === 'summary' ? 3 : kind === 'progress' ? 2 : kind === 'thought' ? 1 : 0;
    if (prio > 0 && prio >= curTurn.replyPriority) {
      curTurn.replyPriority = prio;
      curTurn.replyPreview = text;
    }
  }
  acc.events.push({
    stepIndex: ev.step_index,
    turnIndex: Math.max(0, acc.turnIndex),
    type,
    kind,
    model: modelName,
    createdAt: ts,
    text,
    truncated,
    hasThinking,
    tools,
    isThought,
    contextTokens: totalIn,
    cacheHitRate: Math.round(hitRate * 10) / 10,
  });
}

// Per-conversation incremental state cache
const cache = new Map(); // convId -> { path, acc }

function syncConversation(convId) {
  const path = resolveTranscriptPath(convId);
  if (!path) return null;

  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }

  let entry = cache.get(convId);
  if (!entry || entry.path !== path || st.size < entry.acc.offset) {
    entry = { path, acc: createEmptyAcc() };
    cache.set(convId, entry);
  }

  const { acc } = entry;
  const etag = `${st.mtimeMs}:${st.size}`;

  if (st.size > acc.offset) {
    const delta = st.size - acc.offset;
    const buf = Buffer.allocUnsafe(delta);
    const fd = openSync(path, 'r');
    try {
      let pos = 0;
      while (pos < delta) {
        const n = readSync(fd, buf, pos, delta - pos, acc.offset + pos);
        if (n <= 0) break;
        pos += n;
      }
      const baseOffset = acc.offset - acc.remainderBuf.length;
      const combined = acc.remainderBuf.length > 0
        ? Buffer.concat([acc.remainderBuf, buf.subarray(0, pos)])
        : buf.subarray(0, pos);

      let lineStart = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] === 0x0a) {
          const lineBuf = combined.subarray(lineStart, i);
          const trimmed = lineBuf.toString('utf-8').trim();
          if (trimmed) {
            try {
              ingestEvent(acc, JSON.parse(trimmed), baseOffset + lineStart, i - lineStart);
            } catch {
              // Skip malformed/partial line
            }
          }
          lineStart = i + 1;
        }
      }
      acc.remainderBuf = lineStart < combined.length ? Buffer.from(combined.subarray(lineStart)) : Buffer.alloc(0);
      acc.offset += pos;
    } finally {
      closeSync(fd);
    }
  }

  acc.mtimeMs = st.mtimeMs;
  acc.size = st.size;
  return { path, acc, etag };
}

function loadStats(convId) {
  const synced = syncConversation(convId);
  if (!synced) return null;
  const { acc, etag } = synced;

  const models = [...acc.models.values()]
    .map((m) => {
      const totalInput = m.uncached + m.cacheRead;
      return {
        name: m.name,
        steps: m.steps,
        uncachedInput: m.uncached,
        cacheRead: m.cacheRead,
        totalInput,
        output: m.output,
        grandTotal: totalInput + m.output,
        cacheHitRate: totalInput > 0 ? (m.cacheRead / totalInput) * 100 : 0,
        avgContext: m.steps > 0 ? Math.round(totalInput / m.steps) : 0,
        maxContext: m.maxContext,
        tps: m.tpsSeconds > 0 ? m.tpsOutput / m.tpsSeconds : null,
        tpsSamples: m.tpsSamples,
      };
    })
    .sort((a, b) => b.grandTotal - a.grandTotal);

  let steps = 0;
  let uncachedInput = 0;
  let cacheRead = 0;
  let output = 0;
  for (const m of models) {
    steps += m.steps;
    uncachedInput += m.uncachedInput;
    cacheRead += m.cacheRead;
    output += m.output;
  }
  const totalInput = uncachedInput + cacheRead;
  const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0;

  const sameTotal = acc.sameModel.uncached + acc.sameModel.cacheRead;
  const swTotal = acc.switches.uncached + acc.switches.cacheRead;

  // Estimate context composition since start / last compaction, scaled to exact currentContext.inputTokens
  const totalCtx = acc.lastContextInput || 0;
  let composition = [];
  if (totalCtx > 0) {
    const c = acc.comp;
    const estInitDyn = Math.round(c.initialCharsBeforeFirstCall / 3.5);
    const baseSystem = Math.max(0, Math.min(totalCtx, (c.firstInputTokens || 0) - estInitDyn));
    const remaining = Math.max(0, totalCtx - baseSystem);
    const dynSum =
      c.systemChars + c.userChars + c.assistantChars + c.thinkingChars + c.toolCallChars + c.toolResultChars;
    const scale = (chars) => (dynSum > 0 ? Math.round((chars / dynSum) * remaining) : 0);

    const rawParts = [
      { key: 'system', label: 'System', tokens: baseSystem + (dynSum > 0 ? scale(c.systemChars) : remaining) },
      { key: 'user', label: 'User', tokens: scale(c.userChars) },
      { key: 'assistant', label: 'Assistant', tokens: scale(c.assistantChars) },
      { key: 'thinking', label: 'Thinking', tokens: scale(c.thinkingChars) },
      { key: 'tool_calls', label: 'Tool Calls', tokens: scale(c.toolCallChars) },
      { key: 'tool_results', label: 'Tool Results', tokens: scale(c.toolResultChars) },
    ];
    composition = rawParts
      .filter((p) => p.tokens > 0)
      .map((p) => ({
        ...p,
        pctOfContext: (p.tokens / totalCtx) * 100,
        pctOfLimit: (p.tokens / COMPACTION_REF_TOKENS) * 100,
      }));
  }

  return {
    etag,
    conversationId: convId,
    firstAt: acc.firstAt,
    lastAt: acc.lastAt,
    lastUserAt: acc.lastUserAt,
    userTurns: acc.userTurns,
    checkpoints: acc.checkpoints,
    currentContext: {
      inputTokens: acc.lastContextInput,
      outputTokens: acc.lastContextOutput,
      totalTokens: acc.lastContextInput + acc.lastContextOutput,
      compactionRef: COMPACTION_REF_TOKENS,
      model: acc.lastContextModel,
      stepIndex: acc.lastContextStep,
      composition,
    },
    totals: {
      steps,
      uncachedInput,
      cacheRead,
      totalInput,
      output,
      grandTotal: totalInput + output,
      cacheHitRate,
    },
    switches: {
      count: acc.switches.count,
      uncachedInput: acc.switches.uncached,
      cacheRead: acc.switches.cacheRead,
      cacheHitRate: swTotal > 0 ? (acc.switches.cacheRead / swTotal) * 100 : null,
      sameModelHitRate: sameTotal > 0 ? (acc.sameModel.cacheRead / sameTotal) * 100 : null,
    },
    models,
    kindCounts: { ...acc.kindCounts },
    totalEvents: acc.events.length,
  };
}

function loadActivity(convId, { kindsParam, pageParam, pageSizeParam }) {
  const synced = syncConversation(convId);
  if (!synced) return null;
  const { acc, etag } = synced;

  const allowedKinds = kindsParam
    ? new Set(
        String(kindsParam)
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => ALL_KINDS.includes(s)),
      )
    : new Set(ALL_KINDS);

  const filtered = acc.events.filter((ev) => allowedKinds.has(ev.kind));
  const totalFiltered = filtered.length;
  const pageSize = Math.max(5, Math.min(MAX_PAGE_SIZE, parseInt(pageSizeParam, 10) || DEFAULT_PAGE_SIZE));
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));

  let page;
  if (!pageParam || pageParam === 'latest') {
    page = totalPages;
  } else {
    const parsed = parseInt(pageParam, 10);
    page = Number.isFinite(parsed) ? Math.max(1, Math.min(totalPages, parsed)) : totalPages;
  }

  const start = (page - 1) * pageSize;
  const end = Math.min(totalFiltered, start + pageSize);
  const items = filtered.slice(start, end);

  // Map each user turn to the first matching filtered item index & its page
  const firstIdxByTurn = new Map();
  for (let i = 0; i < filtered.length; i++) {
    const ti = filtered[i].turnIndex ?? 0;
    if (!firstIdxByTurn.has(ti)) firstIdxByTurn.set(ti, i);
  }

  const turns = acc.turns.map((t) => {
    let targetIdx = firstIdxByTurn.get(t.turnIndex);
    if (targetIdx === undefined && filtered.length > 0) {
      const nextIdx = filtered.findIndex((ev) => (ev.turnIndex ?? 0) >= t.turnIndex);
      targetIdx = nextIdx >= 0 ? nextIdx : filtered.length - 1;
    }
    const valid = targetIdx !== undefined && targetIdx >= 0;
    return {
      turnIndex: t.turnIndex,
      stepIndex: t.stepIndex,
      createdAt: t.createdAt,
      prompt: t.prompt,
      replyPreview: t.replyPreview,
      firstFilteredIdx: valid ? targetIdx : -1,
      targetStepIndex: valid ? filtered[targetIdx].stepIndex : -1,
      page: valid ? Math.floor(targetIdx / pageSize) + 1 : 1,
    };
  });

  return {
    etag,
    conversationId: convId,
    totalFiltered,
    page,
    totalPages,
    pageSize,
    startIndex: start,
    endIndex: end,
    items,
    turns,
  };
}

function readStepRecord(convId, stepIndex) {
  const synced = syncConversation(convId);
  if (!synced) return null;
  const { path, acc } = synced;
  const loc = acc.stepIndexMap.get(stepIndex);
  if (!loc) return null;

  let ev = null;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(loc.byteLength);
    let pos = 0;
    while (pos < loc.byteLength) {
      const n = readSync(fd, buf, pos, loc.byteLength - pos, loc.byteOffset + pos);
      if (n <= 0) break;
      pos += n;
    }
    ev = JSON.parse(buf.subarray(0, pos).toString('utf-8'));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }

  // If transcript.jsonl truncated fields, fetch the matching step from transcript_full.jsonl on demand
  if (Array.isArray(ev?.truncated_fields) && ev.truncated_fields.length > 0) {
    const fullPath = resolveTranscriptPath(convId, true);
    if (fullPath) {
      try {
        const raw = readFileSync(fullPath, 'utf-8');
        const needle = `"step_index":${stepIndex}`;
        const needleSp = `"step_index": ${stepIndex}`;
        for (const line of raw.split('\n')) {
          if (!line.includes(needle) && !line.includes(needleSp)) continue;
          const parsed = JSON.parse(line);
          if (parsed?.step_index === stepIndex) {
            ev = parsed;
            break;
          }
        }
      } catch {
        // Fall back to compact transcript record
      }
    }
  }

  const content =
    ev.type === 'USER_INPUT'
      ? cleanUserPrompt(ev.content).full
      : typeof ev.content === 'string'
        ? ev.content.trim()
        : '';
  const thinking = typeof ev.thinking === 'string' ? ev.thinking.trim() : '';
  const tools = summarizeTools(ev.tool_calls);

  return {
    found: true,
    stepIndex: ev.step_index,
    type: ev.type,
    model: ev.model || null,
    createdAt: ev.created_at || null,
    content,
    thinking,
    tools,
  };
}

const app = new SidecarApp();

app.page(
  '/',
  () =>
    new Response(readFileSync(join(__dirname, 'index.html'), 'utf-8'), {
      contentType: 'text/html; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
    }),
);

app.api(
  '/api/stats',
  (data) => {
    const conv = String(data?.conversationId || app.config.conversationId || '').trim();
    if (!conv || !ID_RE.test(conv)) {
      return { conversationId: conv || null, found: false };
    }
    const path = resolveTranscriptPath(conv);
    if (!path) {
      return { conversationId: conv, found: false };
    }
    try {
      const st = statSync(path);
      const etag = `${st.mtimeMs}:${st.size}`;
      if (data?.etag && data.etag === etag) {
        return { conversationId: conv, found: true, unchanged: true, etag };
      }
    } catch {
      return { conversationId: conv, found: false };
    }
    const stats = loadStats(conv);
    if (!stats) return { conversationId: conv, found: false };
    return { found: true, ...stats };
  },
  'GET',
);

app.api(
  '/api/activity',
  (data) => {
    const conv = String(data?.conversationId || app.config.conversationId || '').trim();
    if (!conv || !ID_RE.test(conv)) {
      return { conversationId: conv || null, found: false };
    }
    const activity = loadActivity(conv, {
      kindsParam: data?.kinds,
      pageParam: data?.page,
      pageSizeParam: data?.pageSize,
    });
    if (!activity) return { conversationId: conv, found: false };
    return { found: true, ...activity };
  },
  'GET',
);

app.api(
  '/api/step',
  (data) => {
    const conv = String(data?.conversationId || app.config.conversationId || '').trim();
    const stepIndex = parseInt(data?.stepIndex, 10);
    if (!conv || !ID_RE.test(conv) || !Number.isFinite(stepIndex)) {
      return { found: false };
    }
    return readStepRecord(conv, stepIndex) || { found: false };
  },
  'GET',
);

app.run();
