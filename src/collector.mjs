import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import * as staticPricing from './pricing.mjs';
import { SUBSCRIPTION_PLANS, PRICING_VERSION } from './pricing.mjs';
import { syncRpcModels, noteSeenModels, describeRegistry } from './model-registry.mjs';

const PRICING_MODULE_PATH = path.resolve(import.meta.dirname, 'pricing.mjs');
let activePricing = staticPricing;
let lastPricingMtimeMs = 0;
try {
  lastPricingMtimeMs = fs.statSync(PRICING_MODULE_PATH).mtimeMs;
} catch {}

async function refreshPricingModule() {
  try {
    const mtimeMs = fs.statSync(PRICING_MODULE_PATH).mtimeMs;
    if (mtimeMs !== lastPricingMtimeMs) {
      lastPricingMtimeMs = mtimeMs;
      activePricing = await import(`${pathToFileURL(PRICING_MODULE_PATH).href}?v=${Date.now()}`);
    }
  } catch {}
}

function calculateTurnCost(turn) {
  return activePricing.calculateTurnCost(turn);
}

const HOME = os.homedir();
const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LIVE_QUOTA_FILE = path.join(DATA_DIR, 'live_quota.json');
const DISK_CACHE_FILE = path.join(DATA_DIR, 'parsed_cache.json');

// Incremental file parse cache: filePath -> { mtimeMs, size, pricingVersion, data }
const ENGINE_VERSION = PRICING_VERSION;
const fileCache = new Map();
let cacheDirty = false;

// In-memory cache for Antigravity language_server.exe CSRF token by PID
let cachedLsAuth = { pid: null, httpPort: null, csrfToken: null, checkedAt: 0 };
// In-memory throttle cache for Claude OAuth API live quota polling
let cachedClaudeOAuthQuota = { checkedAt: 0, payload: null };

try {
  if (fs.existsSync(DISK_CACHE_FILE)) {
    const rawCache = JSON.parse(fs.readFileSync(DISK_CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(rawCache)) {
      if (v && v.pricingVersion === ENGINE_VERSION) {
        fileCache.set(k, v);
      }
    }
  }
} catch {}

function flushDiskCache() {
  if (!cacheDirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj = Object.fromEntries(fileCache.entries());
    fs.writeFileSync(DISK_CACHE_FILE, JSON.stringify(obj), 'utf8');
    cacheDirty = false;
  } catch {}
}

export function loadUserSettings() {
  const defaults = {
    claudePlan: 'pro',          // 'pro' | 'team' | 'max5x' | 'max20x'
    antigravityPlan: 'ultra5x', // 'pro' | 'ultra5x' | 'ultra'
    gptPlan: 'plus',            // 'plus' | 'team' | 'pro'
    timezone: 'Asia/Shanghai',  // 'Asia/Shanghai' (东八区) | 'America/New_York' (美东)
    customClaude5hUsd: null,
    customAgy5hUsd: null,
    customGpt5hUsd: null
  };
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    }
  } catch {}
  return defaults;
}

export function saveUserSettings(patch) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = loadUserSettings();
  const updated = { ...current, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

export function loadLiveQuota() {
  try {
    if (fs.existsSync(LIVE_QUOTA_FILE)) {
      return { claude: null, antigravity: null, gpt: null, ...JSON.parse(fs.readFileSync(LIVE_QUOTA_FILE, 'utf8')) };
    }
  } catch {}
  return { claude: null, antigravity: null, gpt: null };
}

export function saveLiveQuota(platform, payload) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = loadLiveQuota();
  current[platform] = {
    ...current[platform],
    ...payload,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(LIVE_QUOTA_FILE, JSON.stringify(current, null, 2), 'utf8');
  return current;
}

function formatWorkspaceLabel(rawPath = '') {
  if (!rawPath) return '未指定工作区 (Global)';
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const scratchMatch = normalized.match(/scratch-workspaces\/[^/]+\/[^/]+\/(scratch-[^/]+)/i);
  if (scratchMatch) {
    return `Claude Workspace (${scratchMatch[1]})`;
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return normalized;
}

function cleanUserPreview(raw = '') {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw
    .replace(/<USER_REQUEST>/gi, '')
    .replace(/<\/USER_REQUEST>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 90);
}

// 1. Scan Claude Code JSONL files in ~/.claude/projects
function parseClaudeJsonlFile(filePath, stat) {
  const cached = fileCache.get(filePath);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.pricingVersion === ENGINE_VERSION
  ) {
    return cached.data;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  // Deduplicate turns by message.id (Claude Code writes multiple streaming lines per API turn)
  const turnMap = new Map();
  const uuidMap = new Map();
  let lastPreRequestTsMs = null;
  let sessionId = path.basename(filePath, '.jsonl');
  let cwd = '';
  let firstUserPrompt = '';
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
      if (obj.cwd && !cwd) cwd = obj.cwd;
      const objTsMs = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
      if (obj.timestamp) {
        if (!firstTimestamp || obj.timestamp < firstTimestamp) firstTimestamp = obj.timestamp;
        if (!lastTimestamp || obj.timestamp > lastTimestamp) lastTimestamp = obj.timestamp;
      }

      const msg = obj.message;
      const isAssistantUsageLine = Boolean(msg && msg.usage && msg.model && msg.model !== '<synthetic>');
      const attachmentType = obj.attachment?.type || null;

      if (obj.uuid) {
        uuidMap.set(obj.uuid, {
          parentUuid: obj.parentUuid || null,
          tsMs: objTsMs,
          msgId: isAssistantUsageLine ? (msg.id || null) : null,
          attachmentType
        });
      }

      if (!isAssistantUsageLine && attachmentType !== 'deferred_tools_record' && !Number.isNaN(objTsMs)) {
        lastPreRequestTsMs = objTsMs;
      }

      if (!firstUserPrompt && obj.type === 'user' && obj.message?.content) {
        if (typeof obj.message.content === 'string') {
          firstUserPrompt = cleanUserPreview(obj.message.content);
        } else if (Array.isArray(obj.message.content)) {
          const textBlock = obj.message.content.find(b => b.type === 'text' && b.text);
          if (textBlock) firstUserPrompt = cleanUserPreview(textBlock.text);
        }
      }

      if (isAssistantUsageLine) {
        const msgId = msg.id || `${sessionId}_line_${i}`;
        const u = msg.usage;
        const inputTokens = Number(u.input_tokens || 0);
        const cacheCreationTokens = Number(u.cache_creation_input_tokens || 0);
        const cacheReadTokens = Number(u.cache_read_input_tokens || 0);
        const outputTokens = Number(u.output_tokens || 0);
        const thinkingTokens = Number(u.output_tokens_details?.thinking_tokens || 0);

        if (inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens === 0) {
          continue;
        }

        const prev = turnMap.get(msgId);
        let reqStartMs = prev?.reqStartMs ?? null;
        if (reqStartMs === null) {
          let currParent = obj.parentUuid || null;
          let hops = 0;
          while (currParent && hops < 8) {
            const pNode = uuidMap.get(currParent);
            if (!pNode) break;
            if (
              pNode.msgId !== msgId &&
              pNode.attachmentType !== 'deferred_tools_record' &&
              !Number.isNaN(pNode.tsMs)
            ) {
              reqStartMs = pNode.tsMs;
              break;
            }
            currParent = pNode.parentUuid;
            hops++;
          }
          if (reqStartMs === null && lastPreRequestTsMs !== null) {
            reqStartMs = lastPreRequestTsMs;
          }
        }

        const endTsMs = !Number.isNaN(objTsMs)
          ? Math.max(prev?.endTsMs || 0, objTsMs)
          : prev?.endTsMs || 0;
        const thinkingDurationMs = Math.max(
          prev?.thinkingDurationMs || 0,
          Number(obj.thinkingDurationMs || 0)
        );

        const toolIds = prev?.toolIds || new Set();
        if (Array.isArray(msg.content)) {
          for (const c of msg.content) {
            if (c.type === 'tool_use') {
              toolIds.add(c.id || `line_${i}`);
            }
          }
        }

        // Always keep latest entry for the same message.id
        turnMap.set(msgId, {
          id: msgId,
          platform: 'claude',
          surface:
            cwd.includes('AppData\\Roaming\\Claude') || cwd.includes('AppData/Roaming/Claude')
              ? 'Claude Desktop'
              : 'Claude Code CLI',
          sessionId,
          timestamp: obj.timestamp || lastTimestamp || new Date(stat.mtimeMs).toISOString(),
          model: msg.model,
          inputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          outputTokens,
          thinkingTokens,
          toolCallsCount: toolIds.size,
          toolIds,
          reqStartMs,
          endTsMs,
          thinkingDurationMs
        });
      }
    } catch {}
  }

  const turns = Array.from(turnMap.values()).map(({ toolIds, reqStartMs, endTsMs, ...t }) => {
    let durationMs = null;
    let tps = null;
    let thinkingTps = null;

    if (t.thinkingDurationMs >= 100 && t.thinkingTokens > 0) {
      const rawThinkTps = t.thinkingTokens / (t.thinkingDurationMs / 1000);
      if (rawThinkTps > 0 && rawThinkTps <= 450) {
        thinkingTps = Number(rawThinkTps.toFixed(1));
      }
    }

    let rawDurMs = reqStartMs && endTsMs > reqStartMs ? endTsMs - reqStartMs : 0;
    if (t.thinkingDurationMs > 0 && (!rawDurMs || rawDurMs < t.thinkingDurationMs)) {
      rawDurMs = t.thinkingDurationMs;
    }
    if (rawDurMs >= 150 && rawDurMs <= 300_000 && t.outputTokens > 0) {
      const rawTps = t.outputTokens / (rawDurMs / 1000);
      if (rawTps > 0 && rawTps <= 450) {
        durationMs = Math.round(rawDurMs);
        tps = Number(rawTps.toFixed(1));
      }
    }
    if (tps === null && thinkingTps !== null && t.thinkingDurationMs > 0) {
      durationMs = Math.round(t.thinkingDurationMs);
      tps = thinkingTps;
    }

    const turnWithPerf = {
      ...t,
      thinkingDurationMs: t.thinkingDurationMs > 0 ? Math.round(t.thinkingDurationMs) : null,
      durationMs,
      tps,
      thinkingTps
    };
    const cost = calculateTurnCost(turnWithPerf);
    return { ...turnWithPerf, ...cost };
  });

  const data = {
    sessionId,
    platform: 'claude',
    surface:
      cwd.includes('AppData\\Roaming\\Claude') || cwd.includes('AppData/Roaming/Claude')
        ? 'Claude Desktop'
        : 'Claude Code CLI',
    projectPath: cwd,
    projectLabel: formatWorkspaceLabel(cwd),
    title: firstUserPrompt || `Claude Session ${sessionId.slice(0, 8)}`,
    firstTimestamp: firstTimestamp || new Date(stat.mtimeMs).toISOString(),
    lastTimestamp: lastTimestamp || new Date(stat.mtimeMs).toISOString(),
    turns
  };

  fileCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pricingVersion: ENGINE_VERSION,
    data
  });
  cacheDirty = true;
  return data;
}

function scanAllClaudeSessions() {
  const claudeProjectsDir = path.join(HOME, '.claude', 'projects');
  if (!fs.existsSync(claudeProjectsDir)) return [];

  const jsonlFiles = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        jsonlFiles.push(fullPath);
      }
    }
  }
  walk(claudeProjectsDir);

  // Merge files sharing the same sessionId (e.g., main session + subagent files)
  const sessionsById = new Map();
  for (const file of jsonlFiles) {
    try {
      const stat = fs.statSync(file);
      const parsed = parseClaudeJsonlFile(file, stat);
      if (parsed.turns.length === 0) continue;

      const existing = sessionsById.get(parsed.sessionId);
      if (!existing) {
        sessionsById.set(parsed.sessionId, {
          ...parsed,
          turns: [...parsed.turns]
        });
      } else {
        // Merge turns deduplicating by turn.id
        const turnIds = new Set(existing.turns.map(t => t.id));
        for (const t of parsed.turns) {
          if (!turnIds.has(t.id)) {
            existing.turns.push(t);
            turnIds.add(t.id);
          }
        }
        if (parsed.firstTimestamp < existing.firstTimestamp) {
          existing.firstTimestamp = parsed.firstTimestamp;
        }
        if (parsed.lastTimestamp > existing.lastTimestamp) {
          existing.lastTimestamp = parsed.lastTimestamp;
        }
        if (existing.title.startsWith('Claude Session') && !parsed.title.startsWith('Claude Session')) {
          existing.title = parsed.title;
        }
      }
    } catch {}
  }

  return Array.from(sessionsById.values());
}

// 2. Scan Google Antigravity sessions across antigravity, antigravity-cli, antigravity-ide
function loadAntigravitySummaries(surfaceDir) {
  const summaryMap = new Map();
  const dbPath = path.join(surfaceDir, 'conversation_summaries.db');
  if (!fs.existsSync(dbPath)) return summaryMap;

  try {
    const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, workspace_uris, parent_conversation_id, agent_name, last_modified_time
         FROM conversation_summaries`
      )
      .all();
    for (const r of rows) {
      let workspacePath = '';
      if (r.workspace_uris) {
        try {
          const uris = JSON.parse(r.workspace_uris);
          if (Array.isArray(uris) && uris.length > 0) {
            workspacePath = decodeURIComponent(uris[0].replace(/^file:\/\/\/?/i, ''));
          }
        } catch {}
      }
      summaryMap.set(r.conversation_id, {
        title: r.title || r.preview || '',
        preview: r.preview || '',
        workspacePath,
        parentConversationId: r.parent_conversation_id || '',
        agentName: r.agent_name || ''
      });
    }
    db.close();
  } catch {}
  return summaryMap;
}

// --- Per-call actual model attribution -------------------------------------------------------
// Antigravity stores one `gen_metadata` protobuf row per LLM call in <surface>/conversations/<id>.db.
// Each row carries the real model that served the call (field 1.21 display label such as
// "Gemini 4 Argon (Low)", field 1.19 base id) plus token usage (1.4.2 input / 1.4.3 output),
// which lets us attribute every turn to the model that was actually invoked, instead of guessing
// from "Model Selection" notes, invoke_subagent arguments or the parent conversation.
function pbReadFields(buf) {
  const fields = [];
  let i = 0;
  const varint = () => {
    let v = 0n;
    let s = 0n;
    let b;
    do {
      if (i >= buf.length) throw new Error('eof');
      b = buf[i++];
      v |= BigInt(b & 0x7f) << s;
      s += 7n;
    } while (b & 0x80);
    return v;
  };
  while (i < buf.length) {
    const tag = varint();
    const fn = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (wt === 0) fields.push({ fn, v: varint() });
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else if (wt === 2) {
      const l = Number(varint());
      if (i + l > buf.length) throw new Error('len');
      fields.push({ fn, b: buf.subarray(i, i + l) });
      i += l;
    } else throw new Error('wire');
  }
  return fields;
}

function loadGenModelRows(dbPath) {
  const rows = [];
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    for (const r of db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all()) {
      try {
        const top = pbReadFields(Buffer.from(r.data));
        const inner = top.find(f => f.fn === 1 && f.b);
        if (!inner) {
          rows.push(null);
          continue;
        }
        const f = pbReadFields(inner.b);
        const usage = f.find(x => x.fn === 4 && x.b);
        const u = usage ? pbReadFields(usage.b) : [];
        const str = fn => {
          const x = f.find(y => y.fn === fn && y.b);
          return x ? x.b.toString('utf8') : '';
        };
        rows.push({
          inputTokens: Number(u.find(x => x.fn === 2)?.v ?? -1n),
          outputTokens: Number(u.find(x => x.fn === 3)?.v ?? -1n),
          modelId: str(19),
          label: str(21)
        });
      } catch {
        rows.push(null);
      }
    }
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {}
  }
  return rows;
}

function dbSignature(dbPath) {
  try {
    const parts = [dbPath, `${dbPath}-wal`].map(p => {
      try {
        const st = fs.statSync(p);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    });
    return parts.join('|');
  } catch {
    return '';
  }
}

/** Align transcript turns to gen_metadata rows (same order) and stamp the real model on each turn. */
function applyGenModels(turns, rows) {
  if (!rows || rows.length === 0 || turns.length === 0) return 0;
  const sameCount = rows.length === turns.length;
  let j = 0;
  let matched = 0;
  turns.forEach((t, i) => {
    let hit = -1;
    for (let k = j; k < Math.min(rows.length, j + 64); k++) {
      const r = rows[k];
      if (r && r.inputTokens === t.inputTokens && r.outputTokens === t.outputTokens) {
        hit = k;
        break;
      }
    }
    if (hit < 0 && sameCount && rows[i]) hit = i;
    if (hit < 0) return;
    j = hit + 1;
    const name = rows[hit].label || rows[hit].modelId;
    if (!name) return;
    t.model = name;
    t.modelSource = 'gen_metadata';
    matched++;
  });
  return matched;
}

function parseAntigravityTranscript(filePath, stat, convId, surfaceLabel, meta = {}) {
  const cacheKey = `${filePath}:${meta.title || ''}:${meta.workspacePath || ''}`;
  const cached = fileCache.get(cacheKey);
  const dbSig = meta.dbPath ? dbSignature(meta.dbPath) : '';
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.pricingVersion === ENGINE_VERSION &&
    cached.dbSig === dbSig &&
    cached.data?.spawnedSubagents !== undefined &&
    !cached.data?.turns?.some(t => String(t.model).startsWith('(['))
  ) {
    return cached.data;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  let activeModel = meta.agentName === 'research' ? 'Gemini 3.8 Flash' : 'Gemini 4 Argon (High)';
  let hasExplicitModel = false;
  let swarmMemberName = '';
  let detectedParentId = meta.parentConversationId || '';
  const spawnedSubagents = {};
  let firstUserPrompt = '';
  let firstTimestamp = null;
  let lastTimestamp = null;
  let workspaceFromLogs = meta.workspacePath || '';
  const turns = [];
  const parsedSteps = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      parsedSteps.push({ obj, lineIdx: i });
    } catch {}
  }

  let fullLinesCache = null;
  const getFullStepObj = lineIdx => {
    try {
      if (fullLinesCache === null) {
        const fullPath = filePath.replace(/transcript\.jsonl$/i, 'transcript_full.jsonl');
        fullLinesCache = fs.existsSync(fullPath)
          ? fs.readFileSync(fullPath, 'utf8').split('\n')
          : [];
      }
      const raw = fullLinesCache[lineIdx]?.trim();
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  for (let idx = 0; idx < parsedSteps.length; idx++) {
    const { obj, lineIdx: i } = parsedSteps[idx];
    try {
      if (obj.created_at) {
        if (!firstTimestamp || obj.created_at < firstTimestamp) firstTimestamp = obj.created_at;
        if (!lastTimestamp || obj.created_at > lastTimestamp) lastTimestamp = obj.created_at;
      }

      if (idx === 0 && obj.type === 'SYSTEM_MESSAGE' && typeof obj.content === 'string') {
        const senderMatch = obj.content.match(/sender=([0-9a-f-]{36})/i);
        if (senderMatch && !detectedParentId) {
          detectedParentId = senderMatch[1];
        }
        if (!firstUserPrompt) {
          const contentMatch = obj.content.match(/content=([^\r\n<]+)/);
          // Swarm workers start with a generic "[swarm] new board message #N" ping; the real
          // assignment text arrives in the next step (handled below), so don't use the ping as title.
          if (contentMatch && !/^\[swarm\]/i.test(contentMatch[1].trim())) {
            firstUserPrompt = cleanUserPreview(contentMatch[1]);
          }
        }
      }

      // Swarm worker: "You have just started. Your assignment (recorded on the board as #1 for @name):\n\n<brief>"
      if (
        !swarmMemberName &&
        idx <= 3 &&
        obj.type === 'SYSTEM_MESSAGE' &&
        typeof obj.content === 'string'
      ) {
        const asg = obj.content.match(
          /Your assignment \(recorded on the board as #\d+ for @([\w-]+)\):\s*([\s\S]*?)(?:\r?\n\s*\r?\n|<\/SYSTEM_MESSAGE>|$)/
        );
        if (asg) {
          swarmMemberName = asg[1];
          const brief = cleanUserPreview(asg[2]);
          if (brief) firstUserPrompt = `[swarm · ${swarmMemberName}] ${brief}`;
          else firstUserPrompt = `[swarm · ${swarmMemberName}]`;
        }
      }

      if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
        const modelMatch = obj.content.match(
          /<USER_SETTINGS_CHANGE>[\s\S]*?Model Selection` from .*? to ([^\r\n<]+?)(?:\.\s+No need|\.\s*$|\r?\n|<)/i
        );
        if (modelMatch) {
          activeModel = modelMatch[1].trim();
          hasExplicitModel = true;
        }
        if (!firstUserPrompt) {
          firstUserPrompt = cleanUserPreview(obj.content);
        }
      }

      if (obj.type === 'PLANNER_RESPONSE') {
        const inputTokens = Number(obj.input_tokens || 0);
        const cacheReadTokens = Number(obj.cache_read_tokens || 0);
        const outputTokens = Number(obj.output_tokens || 0);
        if (inputTokens + cacheReadTokens + outputTokens === 0) continue;

        if (Array.isArray(obj.tool_calls)) {
          if (!workspaceFromLogs) {
            for (const tc of obj.tool_calls) {
              const p = tc.args?.Path || tc.args?.CommandLine || '';
              const m = String(p).match(/([A-Za-z]:\\+[^"'\s\\]+\\+[^"'\s\\]+(?:\\+[^"'\s\\]+)?)/);
              if (m && !/\\(Users|Windows|Program Files|AppData)\\/i.test(m[1])) {
                workspaceFromLogs = m[1].replace(/\\\\/g, '\\');
                break;
              }
            }
          }

          let subCalls = obj.tool_calls.filter(tc => tc.name === 'invoke_subagent');
          if (subCalls.length > 0) {
            if (
              Array.isArray(obj.truncated_fields) &&
              obj.truncated_fields.includes('tool_calls')
            ) {
              const fullObj = getFullStepObj(i);
              if (fullObj && Array.isArray(fullObj.tool_calls)) {
                subCalls = fullObj.tool_calls.filter(tc => tc.name === 'invoke_subagent');
              }
            }
            const spawnedIds = [];
            for (let j = idx + 1; j < parsedSteps.length; j++) {
              const stepJ = parsedSteps[j].obj;
              if (stepJ.type === 'PLANNER_RESPONSE') break;
              if (
                (stepJ.type === 'GENERIC' || stepJ.type === 'SYSTEM_MESSAGE') &&
                typeof stepJ.content === 'string'
              ) {
                let textJ = stepJ.content;
                if (
                  !textJ.includes('conversationId') &&
                  Array.isArray(stepJ.truncated_fields) &&
                  stepJ.truncated_fields.includes('content')
                ) {
                  const fullJ = getFullStepObj(parsedSteps[j].lineIdx);
                  if (fullJ && typeof fullJ.content === 'string') textJ = fullJ.content;
                }
                const mSub = textJ.match(
                  /Created the following subagent:[\s\S]*?"conversationId"\s*:\s*"([0-9a-f-]{36})"/i
                );
                if (mSub) spawnedIds.push(mSub[1]);
              }
            }
            for (let k = 0; k < Math.min(subCalls.length, spawnedIds.length); k++) {
              const rawM = String(subCalls[k].args?.Model || '')
                .replace(/^["'\s\\]+|["'\s\\]+$/g, '')
                .toLowerCase();
              const rawType = String(subCalls[k].args?.TypeName || '')
                .replace(/^["'\s\\]+|["'\s\\]+$/g, '')
                .toLowerCase();
              let subModel = '__INHERIT__';
              if (
                rawM === 'flash' ||
                rawM === 'flash_lite' ||
                rawM.includes('flash') ||
                (!rawM && rawType === 'research')
              ) {
                subModel = 'Gemini 3.8 Flash';
              } else if (rawM === 'pro') {
                subModel = 'Gemini 4 Argon (High)';
              } else if (rawM && rawM !== 'inherit') {
                subModel = rawM;
              }
              spawnedSubagents[spawnedIds[k]] =
                subModel === '__INHERIT__' ? `__INHERIT__:${activeModel}` : subModel;
            }
          }
        }

        let durationMs = null;
        let tps = null;
        const nextStep = parsedSteps[idx + 1]?.obj;
        if (nextStep && nextStep.type === 'GENERIC' && outputTokens > 0) {
          const startMs = obj.created_at ? Date.parse(obj.created_at) : NaN;
          const endMs = nextStep.created_at ? Date.parse(nextStep.created_at) : NaN;
          let rawDurMs = !Number.isNaN(startMs) && !Number.isNaN(endMs) ? endMs - startMs : 0;
          if (rawDurMs <= 0 && idx > 0) {
            const prevStep = parsedSteps[idx - 1]?.obj;
            const prevMs = prevStep?.created_at ? Date.parse(prevStep.created_at) : NaN;
            if (!Number.isNaN(prevMs) && !Number.isNaN(endMs) && endMs > prevMs && endMs - prevMs <= 60_000) {
              rawDurMs = endMs - prevMs;
            }
          }
          if (rawDurMs >= 1000 && rawDurMs <= 180_000) {
            const rawTps = outputTokens / (rawDurMs / 1000);
            if (rawTps > 0 && rawTps <= 400) {
              durationMs = Math.round(rawDurMs);
              tps = Number(rawTps.toFixed(1));
            }
          }
        }

        const turnBase = {
          id: `${convId}_step_${obj.step_index ?? i}`,
          platform: 'antigravity',
          surface: surfaceLabel,
          sessionId: convId,
          timestamp: obj.created_at || lastTimestamp || new Date(stat.mtimeMs).toISOString(),
          model: activeModel,
          inputTokens,
          cacheCreationTokens: 0,
          cacheReadTokens,
          outputTokens,
          thinkingTokens: 0,
          thinkingDurationMs: null,
          durationMs,
          tps,
          thinkingTps: null,
          toolCallsCount: Array.isArray(obj.tool_calls) ? obj.tool_calls.length : 0
        };
        const cost = calculateTurnCost(turnBase);
        turns.push({ ...turnBase, ...cost });
      }
    } catch {}
  }

  const finalWorkspace = meta.workspacePath || workspaceFromLogs;

  // Prefer the model that actually served each call (gen_metadata) over inferred models
  let genMatched = 0;
  if (meta.dbPath && fs.existsSync(meta.dbPath)) {
    genMatched = applyGenModels(turns, loadGenModelRows(meta.dbPath));
    if (genMatched > 0) {
      for (let ti = 0; ti < turns.length; ti++) {
        if (turns[ti].modelSource === 'gen_metadata') {
          turns[ti] = { ...turns[ti], ...calculateTurnCost(turns[ti]) };
        }
      }
    }
  }

  const data = {
    sessionId: convId,
    platform: 'antigravity',
    surface: surfaceLabel,
    projectPath: finalWorkspace,
    projectLabel: formatWorkspaceLabel(finalWorkspace),
    title: meta.title || firstUserPrompt || `Antigravity ${convId.slice(0, 8)}`,
    isSubagent: Boolean(detectedParentId),
    parentConversationId: detectedParentId || null,
    hasExplicitModel,
    hasGenModels: genMatched > 0,
    swarmMemberName: swarmMemberName || null,
    spawnedSubagents,
    firstTimestamp: firstTimestamp || new Date(stat.mtimeMs).toISOString(),
    lastTimestamp: lastTimestamp || new Date(stat.mtimeMs).toISOString(),
    turns
  };

  fileCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pricingVersion: ENGINE_VERSION,
    dbSig,
    data
  });
  cacheDirty = true;
  return data;
}

function loadSwarmRoster(convDir, outMap) {
  const membersPath = path.join(convDir, '.system_generated', 'swarm', 'members.json');
  try {
    if (!fs.existsSync(membersPath)) return;
    const roster = JSON.parse(fs.readFileSync(membersPath, 'utf8'));
    for (const [name, m] of Object.entries(roster?.members || {})) {
      if (!m?.conversation_id || m.role === 'coordinator') continue;
      const model = m.applied_model || m.model || m.desired_model;
      if (model) outMap.set(m.conversation_id, { name, model });
    }
  } catch {}
}

export function scanAllAntigravitySessions() {
  const surfaces = [
    { dir: 'antigravity', label: 'Antigravity 2.0' },
    { dir: 'antigravity-cli', label: 'Antigravity CLI' },
    { dir: 'antigravity-ide', label: 'Antigravity IDE' }
  ];

  const sessions = [];
  // Swarm roster: member conversationId -> { name, model } read from <brain>/<id>/.system_generated/swarm/members.json
  const swarmModelMap = new Map();
  for (const s of surfaces) {
    const surfaceRoot = path.join(HOME, '.gemini', s.dir);
    const brainDir = path.join(surfaceRoot, 'brain');
    if (!fs.existsSync(brainDir)) continue;

    const summaryMap = loadAntigravitySummaries(surfaceRoot);
    let convDirs = [];
    try {
      convDirs = fs.readdirSync(brainDir, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      continue;
    }

    for (const d of convDirs) {
      const convId = d.name;
      loadSwarmRoster(path.join(brainDir, convId), swarmModelMap);
      const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;
      try {
        const stat = fs.statSync(transcriptPath);
        const meta = {
          ...(summaryMap.get(convId) || {}),
          dbPath: path.join(surfaceRoot, 'conversations', `${convId}.db`)
        };
        const parsed = parseAntigravityTranscript(transcriptPath, stat, convId, s.label, meta);
        if (parsed.turns.length > 0) {
          sessions.push(parsed);
        }
      } catch {}
    }
  }

  // Post-pass: resolve subagent models from parent invoke_subagent(Model: "flash" / "pro" / "inherit") calls
  const subagentModelMap = new Map();
  const sessionById = new Map();
  for (const sess of sessions) {
    sessionById.set(sess.sessionId, sess);
    if (sess.spawnedSubagents) {
      for (const [childId, mod] of Object.entries(sess.spawnedSubagents)) {
        subagentModelMap.set(childId, { parentId: sess.sessionId, model: mod });
      }
    }
  }

  for (let pass = 0; pass < 3; pass++) {
    for (const sess of sessions) {
      if (sess.hasExplicitModel) continue;
      const entry = subagentModelMap.get(sess.sessionId);
      const swarmEntry = swarmModelMap.get(sess.sessionId);
      let resolvedModel = null;
      if (swarmEntry) {
        // Swarm member: the roster records the model each worker actually runs on
        resolvedModel = swarmEntry.model;
        if (!sess.swarmMemberName) sess.swarmMemberName = swarmEntry.name;
      } else if (entry) {
        if (entry.model.startsWith('__INHERIT__:')) {
          const parentSess = sessionById.get(entry.parentId);
          resolvedModel =
            parentSess?.turns?.[0]?.model || entry.model.slice('__INHERIT__:'.length);
        } else {
          resolvedModel = entry.model;
        }
      } else if (sess.isSubagent && sess.parentConversationId) {
        const parentSess = sessionById.get(sess.parentConversationId);
        if (parentSess?.turns?.length > 0) {
          resolvedModel = parentSess.turns[0].model;
        }
      }
      if (
        resolvedModel &&
        sess.turns.some(t => t.modelSource !== 'gen_metadata' && t.model !== resolvedModel)
      ) {
        // Only fill in turns without a recorded real model; gen_metadata attribution always wins
        sess.turns = sess.turns.map(t => {
          if (t.modelSource === 'gen_metadata') return t;
          const updatedBase = { ...t, model: resolvedModel };
          return { ...updatedBase, ...calculateTurnCost(updatedBase) };
        });
      }
    }
  }

  return sessions;
}

// 2.5 Scan OpenAI / Codex GPT sessions (~/.codex/sessions, state_5.sqlite, logs_2.sqlite)
function loadCodexAuthInfo() {
  const authPath = path.join(HOME, '.codex', 'auth.json');
  if (!fs.existsSync(authPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const idToken = raw?.tokens?.id_token;
    if (!idToken || typeof idToken !== 'string') return null;
    const parts = idToken.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    const oaiAuth = payload['https://api.openai.com/auth'] || {};
    return {
      email: payload.email || null,
      accountId: oaiAuth.chatgpt_account_id || raw?.account_id || null,
      planType: oaiAuth.chatgpt_plan_type ? String(oaiAuth.chatgpt_plan_type).toLowerCase() : null,
      subscriptionStart: oaiAuth.chatgpt_subscription_active_start || null,
      subscriptionUntil: oaiAuth.chatgpt_subscription_active_until || null
    };
  } catch {
    return null;
  }
}

function formatCodexModelWithEffort(rawModel, effort) {
  const base = rawModel || 'gpt-6.1-sol';
  if (!effort) return base;
  const eff = String(effort).toLowerCase();
  if (eff === 'xhigh') return `${base} (xHigh)`;
  if (eff === 'high') return `${base} (High)`;
  if (eff === 'medium') return `${base} (Medium)`;
  if (eff === 'low') return `${base} (Low)`;
  if (eff === 'minimal') return `${base} (Minimal)`;
  return base;
}

function parseCodexRolloutJsonl(filePath, stat) {
  const cacheKey = `codex_rollout:${filePath}`;
  const cached = fileCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.pricingVersion === ENGINE_VERSION
  ) {
    return cached.data;
  }

  let sessionId = path.basename(filePath, '.jsonl').replace(/^rollout-[^-]+-/, '');
  let cwd = '';
  let activeModel = 'gpt-6.1-sol';
  let activeEffort = '';
  let firstUserPrompt = '';
  let firstTimestamp = null;
  let lastTimestamp = null;
  let prevTotalTokens = 0;
  let prevInputTokens = 0;
  let prevCachedTokens = 0;
  let prevOutputTokens = 0;
  let prevReasoningTokens = 0;
  let lastTurnStartMs = null;
  let pendingToolCalls = 0;
  let latestRateLimits = null;
  const turns = [];

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const tsStr = obj.timestamp || null;
      const tsMs = tsStr ? Date.parse(tsStr) : NaN;
      if (tsStr) {
        if (!firstTimestamp || tsStr < firstTimestamp) firstTimestamp = tsStr;
        if (!lastTimestamp || tsStr > lastTimestamp) lastTimestamp = tsStr;
      }

      if (obj.type === 'session_meta' && obj.payload) {
        if (obj.payload.id) sessionId = obj.payload.id;
        if (obj.payload.cwd && !cwd) cwd = obj.payload.cwd;
        if (obj.payload.model) activeModel = obj.payload.model;
      } else if (obj.type === 'turn_context' && obj.payload) {
        if (obj.payload.cwd && !cwd) cwd = obj.payload.cwd;
        if (obj.payload.model) activeModel = obj.payload.model;
        if (obj.payload.effort || obj.payload.reasoning_effort) {
          activeEffort = obj.payload.effort || obj.payload.reasoning_effort;
        }
        if (!Number.isNaN(tsMs)) lastTurnStartMs = tsMs;
      } else if (obj.type === 'response_item' && obj.payload) {
        if (obj.payload.type === 'function_call' || obj.payload.type === 'custom_tool_call') {
          pendingToolCalls += 1;
        } else if (obj.payload.type === 'message' && obj.payload.role === 'user' && !firstUserPrompt) {
          const cArr = Array.isArray(obj.payload.content) ? obj.payload.content : [];
          for (const c of cArr) {
            if ((c.type === 'input_text' || c.type === 'text') && c.text) {
              const cleaned = cleanUserPreview(c.text);
              if (cleaned) {
                firstUserPrompt = cleaned;
                break;
              }
            }
          }
        }
      } else if (obj.type === 'event_msg' && obj.payload) {
        const p = obj.payload;
        if (p.type === 'user_message' && p.message && !firstUserPrompt) {
          firstUserPrompt = cleanUserPreview(p.message);
        }
        if (p.type === 'task_started' && !Number.isNaN(tsMs)) {
          lastTurnStartMs = tsMs;
        }
        if (p.rate_limits) {
          latestRateLimits = { ...p.rate_limits, timestamp: tsStr || new Date(stat.mtimeMs).toISOString() };
        }
        if (p.type === 'token_count' && p.info) {
          const lastUsage = p.info.last_token_usage;
          const totalUsage = p.info.total_token_usage;
          let inputTokens = 0;
          let cacheReadTokens = 0;
          let outputTokens = 0;
          let thinkingTokens = 0;

          if (lastUsage && (lastUsage.input_tokens > 0 || lastUsage.output_tokens > 0)) {
            const rawIn = Number(lastUsage.input_tokens || 0);
            cacheReadTokens = Number(lastUsage.cached_input_tokens || 0);
            inputTokens = Math.max(0, rawIn - cacheReadTokens);
            outputTokens = Number(lastUsage.output_tokens || 0);
            thinkingTokens = Number(lastUsage.reasoning_output_tokens || 0);
          } else if (totalUsage) {
            const curIn = Number(totalUsage.input_tokens || 0);
            const curCached = Number(totalUsage.cached_input_tokens || 0);
            const curOut = Number(totalUsage.output_tokens || 0);
            const curReas = Number(totalUsage.reasoning_output_tokens || 0);
            const curTot = Number(totalUsage.total_tokens || curIn + curOut);
            if (curTot <= prevTotalTokens) continue;
            const deltaIn = Math.max(0, curIn - prevInputTokens);
            cacheReadTokens = Math.max(0, curCached - prevCachedTokens);
            inputTokens = Math.max(0, deltaIn - cacheReadTokens);
            outputTokens = Math.max(0, curOut - prevOutputTokens);
            thinkingTokens = Math.max(0, curReas - prevReasoningTokens);
            prevInputTokens = curIn;
            prevCachedTokens = curCached;
            prevOutputTokens = curOut;
            prevReasoningTokens = curReas;
            prevTotalTokens = curTot;
          }

          if (inputTokens + cacheReadTokens + outputTokens <= 0) continue;

          let durationMs = null;
          let tps = null;
          if (lastTurnStartMs && !Number.isNaN(tsMs) && tsMs > lastTurnStartMs) {
            const rawDur = tsMs - lastTurnStartMs;
            if (rawDur >= 150 && rawDur <= 600_000 && outputTokens > 0) {
              const rawTps = outputTokens / (rawDur / 1000);
              if (rawTps > 0 && rawTps <= 600) {
                durationMs = Math.round(rawDur);
                tps = Number(rawTps.toFixed(1));
              }
            }
          }
          if (!Number.isNaN(tsMs)) lastTurnStartMs = tsMs;

          const modelWithEffort = formatCodexModelWithEffort(activeModel, activeEffort);
          const turnBase = {
            id: `${sessionId}_turn_${turns.length + 1}`,
            platform: 'gpt',
            surface: 'Codex',
            sessionId,
            timestamp: tsStr || lastTimestamp || new Date(stat.mtimeMs).toISOString(),
            model: modelWithEffort,
            inputTokens,
            cacheCreationTokens: 0,
            cacheReadTokens,
            outputTokens,
            thinkingTokens,
            thinkingDurationMs: null,
            durationMs,
            tps,
            thinkingTps: null,
            toolCallsCount: pendingToolCalls
          };
          pendingToolCalls = 0;
          const cost = calculateTurnCost(turnBase);
          turns.push({ ...turnBase, ...cost });
        }
      }
    } catch {}
  }

  const data = {
    sessionId,
    platform: 'gpt',
    surface: 'Codex',
    projectPath: cwd,
    projectLabel: formatWorkspaceLabel(cwd),
    title: firstUserPrompt || `Codex ${sessionId.slice(0, 8)}`,
    isSubagent: false,
    firstTimestamp: firstTimestamp || new Date(stat.mtimeMs).toISOString(),
    lastTimestamp: lastTimestamp || new Date(stat.mtimeMs).toISOString(),
    latestRateLimits,
    turns
  };

  fileCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pricingVersion: ENGINE_VERSION,
    data
  });
  cacheDirty = true;
  return data;
}

function scanAllGptSessions() {
  const codexRoot = path.join(HOME, '.codex');
  if (!fs.existsSync(codexRoot)) return [];

  const sessionMap = new Map();

  // 1. Read default model & reasoning effort from ~/.codex/config.toml
  let defaultModel = 'gpt-6.1-sol';
  let defaultEffort = 'high';
  let defaultProjectPath = '';
  const configPath = path.join(codexRoot, 'config.toml');
  if (fs.existsSync(configPath)) {
    try {
      const toml = fs.readFileSync(configPath, 'utf8');
      const mMatch = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
      const eMatch = toml.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
      const pMatch = toml.match(/\[projects\.'([^']+)'\]/);
      if (mMatch) defaultModel = mMatch[1];
      if (eMatch) defaultEffort = eMatch[1];
      if (pMatch) defaultProjectPath = pMatch[1];
    } catch {}
  }

  // 2. Scan rollout JSONL files in ~/.codex/sessions and ~/.codex/archived_sessions
  const walkJsonlDirs = dir => {
    if (!fs.existsSync(dir)) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkJsonlDirs(full);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try {
            const stat = fs.statSync(full);
            const parsed = parseCodexRolloutJsonl(full, stat);
            if (parsed.turns.length > 0) {
              sessionMap.set(parsed.sessionId, parsed);
            }
          } catch {}
        }
      }
    } catch {}
  };
  walkJsonlDirs(path.join(codexRoot, 'sessions'));
  walkJsonlDirs(path.join(codexRoot, 'archived_sessions'));

  // 3. Check ~/.codex/state_5.sqlite (`threads` & `projects`)
  const stateDbPath = path.join(codexRoot, 'state_5.sqlite');
  if (fs.existsSync(stateDbPath)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath, { open: true, readOnly: true });
      if (!defaultProjectPath) {
        try {
          const projRow = db.prepare('SELECT path FROM projects LIMIT 1').get();
          if (projRow?.path) defaultProjectPath = projRow.path;
        } catch {}
      }
      const rows = db.prepare('SELECT * FROM threads').all();
      for (const r of rows) {
        if (!r.id) continue;
        if (r.rollout_path && fs.existsSync(r.rollout_path) && !sessionMap.has(r.id)) {
          try {
            const stat = fs.statSync(r.rollout_path);
            const parsed = parseCodexRolloutJsonl(r.rollout_path, stat);
            if (parsed.turns.length > 0) {
              if (r.title || r.first_user_message) {
                parsed.title = cleanUserPreview(r.title || r.first_user_message) || parsed.title;
              }
              if (r.cwd && !parsed.projectPath) {
                parsed.projectPath = r.cwd;
                parsed.projectLabel = formatWorkspaceLabel(r.cwd);
              }
              sessionMap.set(r.id, parsed);
              continue;
            }
          } catch {}
        }
        const totalTok = Number(r.tokens_used || 0);
        if (totalTok > 0 && !sessionMap.has(r.id)) {
          const tsIso = r.updated_at
            ? new Date(Number(r.updated_at) * 1000).toISOString()
            : new Date().toISOString();
          const firstIso = r.created_at
            ? new Date(Number(r.created_at) * 1000).toISOString()
            : tsIso;
          const mod = formatCodexModelWithEffort(
            r.model || defaultModel,
            r.reasoning_effort || defaultEffort
          );
          const cacheReadTokens = Math.round(totalTok * 0.72);
          const inputTokens = Math.round(totalTok * 0.22);
          const outputTokens = Math.max(1, totalTok - cacheReadTokens - inputTokens);
          const turnBase = {
            id: `${r.id}_state_1`,
            platform: 'gpt',
            surface: 'Codex Desktop',
            sessionId: r.id,
            timestamp: tsIso,
            model: mod,
            inputTokens,
            cacheCreationTokens: 0,
            cacheReadTokens,
            outputTokens,
            thinkingTokens: 0,
            thinkingDurationMs: null,
            durationMs: null,
            tps: null,
            thinkingTps: null,
            toolCallsCount: 0
          };
          const cost = calculateTurnCost(turnBase);
          const cwd = r.cwd || defaultProjectPath;
          sessionMap.set(r.id, {
            sessionId: r.id,
            platform: 'gpt',
            surface: 'Codex Desktop',
            projectPath: cwd,
            projectLabel: formatWorkspaceLabel(cwd),
            title: cleanUserPreview(r.title || r.name || r.first_user_message) || `Codex ${r.id.slice(0, 8)}`,
            isSubagent: false,
            firstTimestamp: firstIso,
            lastTimestamp: tsIso,
            turns: [{ ...turnBase, ...cost }]
          });
        }
      }
    } catch {} finally {
      try { db?.close(); } catch {}
    }
  }

  // 4. Scan ~/.codex/logs_2.sqlite for Codex Desktop / App-Server live turns not yet in sessionMap
  const logsDbPath = path.join(codexRoot, 'logs_2.sqlite');
  const logsWalPath = path.join(codexRoot, 'logs_2.sqlite-wal');
  if (fs.existsSync(logsDbPath)) {
    const statMain = fs.statSync(logsDbPath);
    const statWal = fs.existsSync(logsWalPath) ? fs.statSync(logsWalPath) : { mtimeMs: 0, size: 0 };
    const combinedMtime = Math.max(statMain.mtimeMs, statWal.mtimeMs);
    const combinedSize = statMain.size + statWal.size;
    const cacheKey = `codex_logs_db:${logsDbPath}`;
    const cached = fileCache.get(cacheKey);

    let logSessions = null;
    if (
      cached &&
      cached.mtimeMs === combinedMtime &&
      cached.size === combinedSize &&
      cached.pricingVersion === ENGINE_VERSION
    ) {
      logSessions = cached.data;
    } else {
      let db = null;
      try {
        db = new DatabaseSync(logsDbPath, { open: true, readOnly: true });
        const rows = db
          .prepare(
            `SELECT id, ts, ts_nanos, target, thread_id, feedback_log_body
             FROM logs
             WHERE thread_id IS NOT NULL
               AND (
                 feedback_log_body LIKE '%post sampling token usage%'
                 OR target = 'feedback_tags'
                 OR feedback_log_body LIKE '%ToolCall:%'
               )
             ORDER BY ts ASC, ts_nanos ASC, id ASC`
          )
          .all();

        const byThread = new Map();
        for (const r of rows) {
          const tid = r.thread_id;
          if (!tid) continue;
          if (!byThread.has(tid)) {
            byThread.set(tid, {
              threadId: tid,
              cwd: defaultProjectPath,
              model: defaultModel,
              effort: defaultEffort,
              firstTsMs: null,
              lastTsMs: null,
              lastActivityTsMs: null,
              pendingTools: 0,
              prevCumulativeTokens: 0,
              rawSamplingSteps: []
            });
          }
          const st = byThread.get(tid);
          const rowTsMs = Number(r.ts) * 1000 + Math.round(Number(r.ts_nanos || 0) / 1e6);
          if (!st.firstTsMs || rowTsMs < st.firstTsMs) st.firstTsMs = rowTsMs;
          if (!st.lastTsMs || rowTsMs > st.lastTsMs) st.lastTsMs = rowTsMs;

          const body = String(r.feedback_log_body || '');
          const cwdMatch = body.match(/\bcwd=([^\s\x1b]+)/);
          if (cwdMatch && cwdMatch[1]) {
            st.cwd = cwdMatch[1].replace(/^["']|["']$/g, '');
          }
          const modMatch = body.match(/\bmodel=([a-zA-Z0-9._-]+)/);
          if (modMatch && modMatch[1]) {
            st.model = modMatch[1];
          }
          const effMatch = body.match(/reasoning_effort=([a-zA-Z0-9_-]+)/);
          if (effMatch && effMatch[1]) {
            st.effort = effMatch[1];
          }

          if (body.includes('ToolCall:')) {
            st.pendingTools += 1;
            st.lastActivityTsMs = rowTsMs;
          } else if (r.target === 'feedback_tags' && body.includes('stream_events_utils')) {
            st.lastActivityTsMs = rowTsMs;
          } else if (body.includes('post sampling token usage')) {
            const totMatch = body.match(/total_usage_tokens=(\d+)/);
            const turnIdMatch = body.match(/turn_id=([0-9a-f-]+)/i);
            const totalUsageTokens = totMatch ? Number(totMatch[1]) : 0;
            if (totalUsageTokens > 0) {
              st.rawSamplingSteps.push({
                id: r.id,
                turnId: turnIdMatch ? turnIdMatch[1] : `${tid}_${st.rawSamplingSteps.length + 1}`,
                tsMs: rowTsMs,
                startTsMs: st.lastActivityTsMs,
                totalUsageTokens,
                model: st.model,
                effort: st.effort,
                toolCallsCount: st.pendingTools
              });
              st.pendingTools = 0;
              st.lastActivityTsMs = rowTsMs;
            }
          }
        }

        logSessions = [];
        for (const st of byThread.values()) {
          if (st.rawSamplingSteps.length === 0) continue;
          const turns = [];
          let prevTotal = 0;
          for (let idx = 0; idx < st.rawSamplingSteps.length; idx++) {
            const step = st.rawSamplingSteps[idx];
            const curTotal = step.totalUsageTokens;
            let inputTokens = 0;
            let cacheReadTokens = 0;
            let outputTokens = 0;

            if (idx === 0 || curTotal < prevTotal) {
              // First sampling request in thread: initial prompt + system instructions (mostly cached in Codex)
              cacheReadTokens = Math.round(curTotal * 0.80);
              outputTokens = Math.min(1200, Math.max(120, Math.round(curTotal * 0.03)));
              inputTokens = Math.max(0, curTotal - cacheReadTokens - outputTokens);
            } else {
              // Subsequent step in same thread: previous context is cached read, delta is new tool output + assistant output
              const delta = Math.max(100, curTotal - prevTotal);
              cacheReadTokens = prevTotal;
              outputTokens = Math.min(2500, Math.max(80, Math.round(delta * 0.35)));
              inputTokens = Math.max(0, delta - outputTokens);
            }
            prevTotal = curTotal;

            let durationMs = null;
            let tps = null;
            if (step.startTsMs && step.tsMs > step.startTsMs) {
              const rawDur = step.tsMs - step.startTsMs;
              if (rawDur >= 150 && rawDur <= 180_000 && outputTokens > 0) {
                const rawTps = outputTokens / (rawDur / 1000);
                if (rawTps > 0 && rawTps <= 500) {
                  durationMs = Math.round(rawDur);
                  tps = Number(rawTps.toFixed(1));
                }
              }
            }

            const modelLabelStr = formatCodexModelWithEffort(step.model, step.effort);
            const turnBase = {
              id: `${st.threadId}_step_${step.id}`,
              platform: 'gpt',
              surface: 'Codex Desktop',
              sessionId: st.threadId,
              timestamp: new Date(step.tsMs).toISOString(),
              model: modelLabelStr,
              inputTokens,
              cacheCreationTokens: 0,
              cacheReadTokens,
              outputTokens,
              thinkingTokens: 0,
              thinkingDurationMs: null,
              durationMs,
              tps,
              thinkingTps: null,
              toolCallsCount: step.toolCallsCount
            };
            const cost = calculateTurnCost(turnBase);
            turns.push({ ...turnBase, ...cost });
          }

          const projLabel = formatWorkspaceLabel(st.cwd);
          logSessions.push({
            sessionId: st.threadId,
            platform: 'gpt',
            surface: 'Codex Desktop',
            projectPath: st.cwd,
            projectLabel: projLabel,
            title: `Codex · ${projLabel.split('/').pop() || st.threadId.slice(0, 8)} (${st.threadId.slice(-6)})`,
            isSubagent: false,
            firstTimestamp: new Date(st.firstTsMs || Date.now()).toISOString(),
            lastTimestamp: new Date(st.lastTsMs || Date.now()).toISOString(),
            turns
          });
        }

        fileCache.set(cacheKey, {
          mtimeMs: combinedMtime,
          size: combinedSize,
          pricingVersion: ENGINE_VERSION,
          data: logSessions
        });
        cacheDirty = true;
      } catch {
        logSessions = [];
      } finally {
        try { db?.close(); } catch {}
      }
    }

    if (Array.isArray(logSessions)) {
      for (const ls of logSessions) {
        if (!sessionMap.has(ls.sessionId)) {
          sessionMap.set(ls.sessionId, ls);
        }
      }
    }
  }

  return Array.from(sessionMap.values());
}

// 3. Official Local Quota Discovery: Claude Desktop `plan-usage-history.json` + `.claude.json`
function loadClaudeOfficialPlanUsage() {
  let accountInfo = null;
  const claudeJsonPath = path.join(HOME, '.claude.json');
  if (fs.existsSync(claudeJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      if (raw.oauthAccount) {
        accountInfo = {
          email: raw.oauthAccount.emailAddress || null,
          orgUuid: raw.oauthAccount.organizationUuid || null,
          organizationType: raw.oauthAccount.organizationType || null, // e.g. 'claude_pro'
          rateLimitTier: raw.oauthAccount.organizationRateLimitTier || null,
          subscriptionCreatedAt: raw.oauthAccount.subscriptionCreatedAt || null
        };
      }
    } catch {}
  }

  // Locate plan-usage-history.json across standard Roaming and Windows MSIX Packages
  const candidatePaths = [
    path.join(HOME, 'AppData', 'Roaming', 'Claude', 'plan-usage-history.json')
  ];
  const packagesDir = path.join(HOME, 'AppData', 'Local', 'Packages');
  if (fs.existsSync(packagesDir)) {
    try {
      for (const d of fs.readdirSync(packagesDir)) {
        if (/^Claude_/i.test(d)) {
          candidatePaths.unshift(
            path.join(packagesDir, d, 'LocalCache', 'Roaming', 'Claude', 'plan-usage-history.json')
          );
        }
      }
    } catch {}
  }

  for (const p of candidatePaths) {
    if (!fs.existsSync(p)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(parsed.samples) && parsed.samples.length > 0) {
        const validSamples = parsed.samples.filter(
          s =>
            s &&
            typeof s.t === 'number' &&
            s.u &&
            (typeof s.u.fh === 'number' || typeof s.u.sd === 'number') &&
            (!accountInfo?.orgUuid || !s.org || s.org === accountInfo.orgUuid)
        );
        if (validSamples.length > 0) {
          return {
            sourcePath: p,
            accountInfo,
            samples: validSamples
          };
        }
      }
    } catch {}
  }

  return { sourcePath: null, accountInfo, samples: [] };
}

// 3.5 Official Live Quota Discovery: Claude Code OAuth API (`https://api.anthropic.com/api/oauth/usage`)
async function fetchClaudeOfficialOAuthQuota() {
  const now = Date.now();
  if (cachedClaudeOAuthQuota.payload && now - cachedClaudeOAuthQuota.checkedAt < 45_000) {
    return cachedClaudeOAuthQuota.payload;
  }
  const credPath = path.join(HOME, '.claude', '.credentials.json');
  if (!fs.existsSync(credPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const oauth = raw?.claudeAiOauth;
    const accessToken = oauth?.accessToken;
    if (!accessToken) return null;
    if (oauth.expiresAt && Number(oauth.expiresAt) < now - 60_000) return null;

    cachedClaudeOAuthQuota.checkedAt = now;
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(2500)
    }).catch(() => null);

    if (!res?.ok) return cachedClaudeOAuthQuota.payload;
    const data = await res.json().catch(() => null);
    if (!data || (!data.five_hour && !data.seven_day)) return cachedClaudeOAuthQuota.payload;

    const fh = data.five_hour;
    const sd = data.seven_day;
    const bd = data.seven_day_breakdown;

    const payload = {
      source: 'claude_oauth_api',
      fiveHour: fh
        ? {
            usedPercentage: typeof fh.utilization === 'number' ? Number(fh.utilization) : null,
            resetsAt: fh.resets_at || null
          }
        : null,
      sevenDay: sd
        ? {
            usedPercentage: typeof sd.utilization === 'number' ? Number(sd.utilization) : null,
            resetsAt: sd.resets_at || null,
            windowStartedAt: bd?.window_started_at || null,
            asOf: bd?.as_of || new Date(now).toISOString()
          }
        : null,
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null
    };

    cachedClaudeOAuthQuota.payload = payload;
    saveLiveQuota('claude', payload);
    return payload;
  } catch {
    return cachedClaudeOAuthQuota.payload;
  }
}

// 4. Official Local Quota Discovery: Antigravity `language_server.exe` RPC (`GetUserStatus`)
export async function fetchAntigravityOfficialQuota() {
  const lsLog = path.join(HOME, 'AppData', 'Roaming', 'Antigravity', 'logs', 'language_server.log');
  if (!fs.existsSync(lsLog)) return null;

  try {
    const logContent = fs.readFileSync(lsLog, 'utf8');
    const pidMatch = [...logContent.matchAll(/Starting language server process with pid (\d+)/g)].at(-1);
    const httpPortMatch = [...logContent.matchAll(/listening on random port at (\d+) for HTTP\b/g)].at(-1);
    const pid = pidMatch?.[1] || null;
    const httpPort = httpPortMatch?.[1] || null;
    if (!httpPort) return null;

    if (cachedLsAuth.pid !== pid || cachedLsAuth.httpPort !== httpPort || !cachedLsAuth.csrfToken) {
      // Only query process command line when PID or port changed (and throttle to at most once per 30s on failure)
      if (Date.now() - cachedLsAuth.checkedAt > 10000) {
        cachedLsAuth.checkedAt = Date.now();
        try {
          const procJson = execSync(
            'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'language_server.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"',
            { encoding: 'utf8', timeout: 3500 }
          );
          const proc = JSON.parse(procJson);
          const list = Array.isArray(proc) ? proc : proc ? [proc] : [];
          const matched = list.find(p => String(p.ProcessId) === String(pid)) || list[0];
          const csrf = matched?.CommandLine?.match(/--csrf_token\s+([^\s"]+)/)?.[1] || null;
          if (csrf) {
            cachedLsAuth = { pid, httpPort, csrfToken: csrf, checkedAt: Date.now() };
          }
        } catch {}
      }
    }

    if (!cachedLsAuth.csrfToken) return null;

    const rpcHeaders = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-codeium-csrf-token': cachedLsAuth.csrfToken
    };

    const [statusRes, summaryRes] = await Promise.all([
      fetch(
        `http://127.0.0.1:${httpPort}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
        {
          method: 'POST',
          headers: rpcHeaders,
          body: JSON.stringify({
            metadata: {
              ideName: 'antigravity',
              extensionName: 'antigravity',
              locale: 'zh'
            }
          }),
          signal: AbortSignal.timeout(900)
        }
      ).catch(() => null),
      fetch(
        `http://127.0.0.1:${httpPort}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
        {
          method: 'POST',
          headers: rpcHeaders,
          body: JSON.stringify({ forceRefresh: false }),
          signal: AbortSignal.timeout(900)
        }
      ).catch(() => null)
    ]);

    if (!statusRes?.ok && !summaryRes?.ok) return null;

    const statusData = statusRes?.ok ? await statusRes.json().catch(() => null) : null;
    const summaryData = summaryRes?.ok ? await summaryRes.json().catch(() => null) : null;

    const us = statusData?.userStatus || {};
    const groups = summaryData?.response?.groups || [];

    const toBucketObj = (bucket, fallbackLabel = '') => {
      if (!bucket) return null;
      const rem = Number(bucket.remainingFraction ?? 1);
      const usedPct = Number(Math.max(0, Math.min(100, (1 - rem) * 100)).toFixed(2));
      return {
        bucketId: bucket.bucketId || fallbackLabel,
        displayName: bucket.displayName || fallbackLabel,
        window: bucket.window || '',
        description: bucket.description || '',
        remainingFraction: rem,
        usedPercentage: Number(usedPct.toFixed(1)),
        usedPercentageExact: usedPct,
        remainingPercentage: Number((100 - usedPct).toFixed(1)),
        nativeRemainingPct: Math.round(rem * 100), // Matches Antigravity native UI `Math.round(rem * 100)% left`
        resetsAt: bucket.resetTime || null
      };
    };

    // Extract buckets from RetrieveUserQuotaSummary (`Gemini Models` & `Claude and GPT models`)
    const geminiGroup =
      groups.find(g => /gemini/i.test(g.displayName)) || groups[0] || null;
    const thirdPartyGroup =
      groups.find(g => /claude|gpt/i.test(g.displayName)) || groups[1] || null;

    const findBucket = (grp, winKey) =>
      (grp?.buckets || []).find(
        b =>
          String(b.window || '').toLowerCase() === winKey ||
          String(b.bucketId || '').toLowerCase().includes(winKey)
      );

    let gemini5h = toBucketObj(findBucket(geminiGroup, '5h'), 'gemini-5h');
    const geminiWeekly = toBucketObj(findBucket(geminiGroup, 'weekly'), 'gemini-weekly');
    let thirdParty5h = toBucketObj(findBucket(thirdPartyGroup, '5h'), '3p-5h');
    const thirdPartyWeekly = toBucketObj(findBucket(thirdPartyGroup, 'weekly'), '3p-weekly');

    // Fallback to GetUserStatus clientModelConfigs if RetrieveUserQuotaSummary wasn't available
    const configs = us.cascadeModelConfigData?.clientModelConfigs || [];
    // Auto-discover newly released models from the live model list (e.g. Gemini 4 Carbon)
    try {
      syncRpcModels(configs);
    } catch {}
    if (!gemini5h) {
      const geminiConfig =
        configs.find(c => /gemini-4-argon-high/i.test(c.modelId)) ||
        configs.find(c => /gemini/i.test(c.modelId));
      if (geminiConfig?.quotaInfo) {
        gemini5h = toBucketObj(
          {
            bucketId: 'gemini-5h',
            displayName: geminiConfig.label,
            window: '5h',
            remainingFraction: geminiConfig.quotaInfo.remainingFraction,
            resetTime: geminiConfig.quotaInfo.resetTime
          },
          'gemini-5h'
        );
      }
    }
    if (!thirdParty5h) {
      const claudeConfig =
        configs.find(c => /claude-opus-5-5-high/i.test(c.modelId)) ||
        configs.find(c => /claude/i.test(c.modelId));
      if (claudeConfig?.quotaInfo) {
        thirdParty5h = toBucketObj(
          {
            bucketId: '3p-5h',
            displayName: claudeConfig.label,
            window: '5h',
            remainingFraction: claudeConfig.quotaInfo.remainingFraction,
            resetTime: claudeConfig.quotaInfo.resetTime
          },
          '3p-5h'
        );
      }
    }

    const payload = {
      source: 'language_server_rpc',
      email: us.email || null,
      userTierId: us.userTier?.id || null,       // e.g. 'g1-ultra-lite-tier'
      userTierName: us.userTier?.name || null,   // e.g. 'Google AI Ultra'
      userTierUpgradeText: us.userTier?.upgradeSubscriptionText || null,
      summaryDescription: summaryData?.response?.description || null,
      fiveHour: gemini5h
        ? {
            usedPercentage: gemini5h.usedPercentage,
            remainingPercentage: gemini5h.remainingPercentage,
            nativeRemainingPct: gemini5h.nativeRemainingPct,
            resetsAt: gemini5h.resetsAt
          }
        : null,
      pools: {
        gemini: gemini5h,
        geminiWeekly,
        claude: thirdParty5h,
        claudeWeekly: thirdPartyWeekly
      }
    };

    saveLiveQuota('antigravity', payload);
    return payload;
  } catch {
    return null;
  }
}

// Helper: Discrete fixed-duration cycle walker (for fallback when no server resetTime is present)
// Starts a window of `windowDurationMs` at the first turn; any turn before `wStart + windowDurationMs`
// falls in that window; the first turn at/after `wStart + windowDurationMs` starts a new window.
function findDiscreteCycleWindow(sortedTurns, windowDurationMs, nowMs) {
  if (sortedTurns.length === 0) {
    return { cycleStartMs: nowMs - windowDurationMs, resetsAtMs: null, turnsInCycle: [] };
  }
  let wStart = sortedTurns[0].ts;
  for (let i = 1; i < sortedTurns.length; i++) {
    const ts = sortedTurns[i].ts;
    if (ts >= wStart + windowDurationMs) {
      wStart = ts;
    }
  }
  // If the last discrete window already expired before nowMs, the active window is empty & reset
  if (nowMs >= wStart + windowDurationMs) {
    return { cycleStartMs: nowMs, resetsAtMs: null, turnsInCycle: [] };
  }
  const turnsInCycle = sortedTurns.filter(t => t.ts >= wStart);
  return {
    cycleStartMs: wStart,
    resetsAtMs: wStart + windowDurationMs,
    turnsInCycle
  };
}

// Dynamic Timezone Engine: Supports UTC+8 ('Asia/Shanghai' / 东八区) and US Eastern ('America/New_York' / 美东, auto EDT/EST)
const DAY_MS = 24 * 3600 * 1000;
let activeTimezoneId = 'Asia/Shanghai';

function normalizeTimezoneId(tz) {
  if (!tz) return 'Asia/Shanghai';
  const s = String(tz).trim().toLowerCase();
  if (s === 'et' || s === 'us-east' || s === 'est' || s === 'edt' || s.includes('new_york') || s.includes('america')) {
    return 'America/New_York';
  }
  return 'Asia/Shanghai';
}

function getTzLabel(tz = activeTimezoneId) {
  return normalizeTimezoneId(tz) === 'America/New_York' ? '美东 (ET)' : '东八区 (UTC+8)';
}

// Compute exact UTC offset in ms for a given timestamp in the active timezone (handles US Eastern DST automatically)
function getTzOffsetMsAt(tsMs, tz = activeTimezoneId) {
  const norm = normalizeTimezoneId(tz);
  if (norm === 'Asia/Shanghai') {
    return 8 * 3600 * 1000;
  }
  // America/New_York: DST starts 2nd Sunday in March at 07:00 UTC (2am EST) and ends 1st Sunday in November at 06:00 UTC (2am EDT)
  const d = new Date(tsMs);
  const year = d.getUTCFullYear();
  // March 1st UTC day of week
  const mar1Day = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const secondSunMar = 8 + ((7 - mar1Day) % 7);
  const dstStartUtcMs = Date.UTC(year, 2, secondSunMar, 7, 0, 0, 0);

  // November 1st UTC day of week
  const nov1Day = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstSunNov = 1 + ((7 - nov1Day) % 7);
  const dstEndUtcMs = Date.UTC(year, 10, firstSunNov, 6, 0, 0, 0);

  const isEdt = tsMs >= dstStartUtcMs && tsMs < dstEndUtcMs;
  return (isEdt ? -4 : -5) * 3600 * 1000;
}

function toTzShiftedDate(msOrIso, tz = activeTimezoneId) {
  const ts = typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso);
  if (Number.isNaN(ts)) return null;
  return new Date(ts + getTzOffsetMsAt(ts, tz));
}

function toLocalDateStr(msOrIso, tz = activeTimezoneId) {
  const d = toTzShiftedDate(msOrIso, tz);
  if (!d) return '';
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function toLocalHM(msOrIso, tz = activeTimezoneId) {
  const d = toTzShiftedDate(msOrIso, tz);
  if (!d) return '--:--';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function toLocalHMS(msOrIso, tz = activeTimezoneId) {
  const d = toTzShiftedDate(msOrIso, tz);
  if (!d) return '--:--:--';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

function getTzDayStartMs(msOrIso, tz = activeTimezoneId) {
  const ts = typeof msOrIso === 'number' ? msOrIso : Date.parse(msOrIso);
  if (Number.isNaN(ts)) return 0;
  const offsetMs = getTzOffsetMsAt(ts, tz);
  const d = new Date(ts + offsetMs);
  const approxMidnightMs =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) - offsetMs;
  // Refine once in case a DST boundary was crossed during the day
  const offsetAtMidnight = getTzOffsetMsAt(approxMidnightMs, tz);
  return (
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) - offsetAtMidnight
  );
}

function getTzWeekdayIndex(msOrIso, tz = activeTimezoneId) {
  const d = toTzShiftedDate(msOrIso, tz);
  return d ? d.getUTCDay() : 0;
}

function getTzHour(msOrIso, tz = activeTimezoneId) {
  const d = toTzShiftedDate(msOrIso, tz);
  return d ? d.getUTCHours() : 0;
}

// Compute daily breakdown of 7-day weekly quota + 5-hour windows triggered/used per day
function buildWeeklyDailyBreakdown({
  sortedTurns,
  cycle7dStartMs,
  sevenDayResetsAtMs,
  sevenDayUsedPct,
  sevenDayBudgetUsd,
  fiveHourBudgetUsd,
  nowMs,
  officialSamples = []
}) {
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const START_GRACE_MS = 45 * 1000;
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const todayStr = toLocalDateStr(nowMs);

  const effStartMs = cycle7dStartMs || nowMs - SEVEN_D_MS;
  const effEndMs = sevenDayResetsAtMs || effStartMs + SEVEN_D_MS;

  // 1. Reconstruct all discrete 5-hour windows across the recent history up to nowMs
  const turnsForWindows = sortedTurns.filter(t => t.ts >= effStartMs - FIVE_H_MS);
  const all5hWindows = [];
  let curWin = null;
  for (const t of turnsForWindows) {
    if (!curWin || t.ts >= curWin.endMs) {
      curWin = {
        index: all5hWindows.length + 1,
        startMs: t.ts,
        endMs: t.ts + FIVE_H_MS,
        lastTurnMs: t.ts,
        turns: 1,
        costUsd: t.totalCostUsd,
        totalTokens:
          t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens + t.outputTokens
      };
      all5hWindows.push(curWin);
    } else {
      curWin.lastTurnMs = t.ts;
      curWin.turns += 1;
      curWin.costUsd += t.totalCostUsd;
      curWin.totalTokens +=
        t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens + t.outputTokens;
    }
  }

  // 2. Build the calendar days in active timezone covering [effStartMs .. min(nowMs, effEndMs)]
  const startDayMs = getTzDayStartMs(effStartMs);
  const endDayBoundMs = Math.max(nowMs, effEndMs - 1000);
  const endDayMs = getTzDayStartMs(endDayBoundMs);

  const dayList = [];
  const dayMap = new Map();
  let cursorMs = startDayMs;
  let safety = 0;
  while (cursorMs <= endDayMs && safety < 10) {
    safety++;
    const dateStr = toLocalDateStr(cursorMs + 2 * 3600 * 1000);
    const dayStartMs = getTzDayStartMs(cursorMs + 2 * 3600 * 1000);
    const nextDayStartMs = getTzDayStartMs(dayStartMs + 26 * 3600 * 1000);
    const dayEndMs = nextDayStartMs > dayStartMs ? nextDayStartMs : dayStartMs + DAY_MS;
    const sliceStartMs = Math.max(dayStartMs, effStartMs - START_GRACE_MS);
    const sliceEndMs = Math.min(dayEndMs, effEndMs);

    const entry = {
      date: dateStr,
      shortDate: dateStr.slice(5),
      weekday: weekdays[getTzWeekdayIndex(dayStartMs + 2 * 3600 * 1000)],
      isToday: dateStr === todayStr,
      isFuture: dayStartMs > nowMs,
      isPartialCycleStart: dayStartMs < effStartMs && effStartMs < dayEndMs,
      isPartialCycleEnd: dayStartMs < effEndMs && effEndMs < dayEndMs,
      cycleSliceNote:
        dayStartMs < effStartMs && effStartMs < dayEndMs
          ? `${toLocalHM(effStartMs)} 起算`
          : dayStartMs < effEndMs && effEndMs < dayEndMs
          ? `至 ${toLocalHM(effEndMs)} 重置`
          : '',
      dayStartMs,
      dayEndMs,
      sliceStartMs,
      sliceEndMs,
      turnsList: [],
      allDayTurnsList: []
    };
    dayList.push(entry);
    dayMap.set(dateStr, entry);
    cursorMs = dayEndMs;
  }

  // 3. Assign turns to days (both strictly inside current 7d cycle and full-day for reference)
  const cycleTurns = sortedTurns.filter(
    t => t.ts >= effStartMs - START_GRACE_MS && t.ts <= effEndMs
  );
  for (const t of sortedTurns) {
    const dStr = toLocalDateStr(t.ts);
    const dEntry = dayMap.get(dStr);
    if (!dEntry) continue;
    dEntry.allDayTurnsList.push(t);
    if (t.ts >= effStartMs - START_GRACE_MS && t.ts <= effEndMs) {
      dEntry.turnsList.push(t);
    }
  }

  // 4. Check if official `plan-usage-history.json` samples exist in this 7d cycle for direct sd delta
  const totalCycleCostUsd = cycleTurns.reduce((s, t) => s + t.totalCostUsd, 0);
  const targetWeekUsedPct = Math.max(0, Number(sevenDayUsedPct || 0));
  const safe7dBudget = Math.max(0.01, Number(sevenDayBudgetUsd || 100));
  const safe5hBudget = Math.max(0.01, Number(fiveHourBudgetUsd || 20));

  // Compute raw weekly quota % per day (calibrated so sum across cycle days equals official `sevenDayUsedPct`)
  let rawPctSum = 0;
  for (const d of dayList) {
    const metrics = sumTurnMetrics(d.turnsList);
    d.metrics = metrics;
    if (totalCycleCostUsd > 0 && targetWeekUsedPct > 0) {
      d.rawWeeklyPct = (metrics.costUsd / totalCycleCostUsd) * targetWeekUsedPct;
    } else {
      d.rawWeeklyPct = Math.min(100, (metrics.costUsd / safe7dBudget) * 100);
    }
    rawPctSum += d.rawWeeklyPct;
  }

  // Also count distinct 5h windows active in each day and across the whole 7d cycle
  const cycle5hWindows = all5hWindows.filter(
    w => w.lastTurnMs >= effStartMs - START_GRACE_MS && w.startMs <= effEndMs
  );

  let cumulativeRawPct = 0;
  const formattedDays = dayList.map(d => {
    const m = d.metrics;
    const weeklyQuotaPct = Number(d.rawWeeklyPct.toFixed(2));
    cumulativeRawPct += d.rawWeeklyPct;
    const cumulativeWeeklyPct = Number(Math.min(100, cumulativeRawPct).toFixed(1));
    const shareOfUsedPct =
      rawPctSum > 0 ? Number(((d.rawWeeklyPct / rawPctSum) * 100).toFixed(1)) : 0;

    // Discrete 5h windows that had turns on this day (within the 7d cycle)
    const dayWindows = [];
    for (const w of cycle5hWindows) {
      // Find turns belonging toboth this 5h window and this day's cycle turns
      const turnsInWinOnDay = d.turnsList.filter(
        t => t.ts >= w.startMs && t.ts < w.endMs
      );
      if (turnsInWinOnDay.length > 0) {
        const winCostOnDay = turnsInWinOnDay.reduce((s, t) => s + t.totalCostUsd, 0);
        const winPctLoad = Math.min(100, Number(((winCostOnDay / safe5hBudget) * 100).toFixed(1)));
        const firstTs = turnsInWinOnDay[0].ts;
        const winEndOnDay = Math.min(w.endMs, d.dayEndMs);
        dayWindows.push({
          windowIndex: w.index,
          startedToday: w.startMs >= d.dayStartMs && w.startMs < d.dayEndMs,
          startLabel: toLocalHM(firstTs),
          endLabel: toLocalHM(w.endMs),
          rangeLabel: `${toLocalHM(w.startMs)}~${toLocalHM(w.endMs)}`,
          turns: turnsInWinOnDay.length,
          costUsd: Number(winCostOnDay.toFixed(2)),
          fiveHourUsedPct: winPctLoad
        });
      }
    }

    // Equivalent number of full 100% 5-hour windows consumed on this day
    // Using both cost/fiveHourBudgetUsd and weeklyQuotaPct * (sevenDayBudgetUsd / fiveHourBudgetUsd)
    const fiveHourEquivalent = Number((m.costUsd / safe5hBudget).toFixed(2));

    return {
      date: d.date,
      shortDate: d.shortDate,
      weekday: d.weekday,
      isToday: d.isToday,
      isFuture: d.isFuture,
      cycleSliceNote: d.cycleSliceNote,
      weeklyQuotaPct,
      cumulativeWeeklyPct,
      shareOfUsedPct,
      fiveHourWindowsCount: dayWindows.length,
      fiveHourWindowsStarted: dayWindows.filter(w => w.startedToday).length,
      fiveHourEquivalent,
      fiveHourWindows: dayWindows,
      turns: m.turns,
      totalTokens: m.totalTokens,
      inputTokens: m.inputTokens,
      cacheReadTokens: m.cacheReadTokens,
      outputTokens: m.outputTokens,
      costUsd: Number(m.costUsd.toFixed(2)),
      avgTps: m.avgTps,
      peakTps: m.peakTps
    };
  });

  const activeDaysCount = formattedDays.filter(d => d.turns > 0).length;
  const elapsedDaysCount = Math.max(
    1,
    formattedDays.filter(d => !d.isFuture).length
  );
  const avgDailyWeeklyPct = Number((targetWeekUsedPct / elapsedDaysCount).toFixed(2));
  const total5hEquivalents = Number(
    formattedDays.reduce((s, d) => s + d.fiveHourEquivalent, 0).toFixed(2)
  );
  const peakDay = formattedDays.reduce(
    (best, d) => (!best || d.weeklyQuotaPct > best.weeklyQuotaPct ? d : best),
    null
  );

  return {
    cycleStartAt: new Date(effStartMs).toISOString(),
    resetsAt: new Date(effEndMs).toISOString(),
    totalWeeklyUsedPct: Number(targetWeekUsedPct.toFixed(1)),
    remainingWeeklyPct: Number(Math.max(0, 100 - targetWeekUsedPct).toFixed(1)),
    activeDaysCount,
    elapsedDaysCount,
    avgDailyWeeklyPct,
    totalFiveHourWindowsCount: cycle5hWindows.length,
    totalFiveHourEquivalents: total5hEquivalents,
    fiveHourToWeeklyRatio: Number((safe7dBudget / safe5hBudget).toFixed(1)),
    peakDay: peakDay && peakDay.turns > 0 ? { date: peakDay.date, shortDate: peakDay.shortDate, weekday: peakDay.weekday, weeklyQuotaPct: peakDay.weeklyQuotaPct } : null,
    days: formattedDays
  };
}

function createTpsTracker() {
  return {
    timedTurns: 0,
    timedOutputTokens: 0,
    timedDurationMs: 0,
    peakTps: 0,
    thinkingTimedTurns: 0,
    thinkingTimedTokens: 0,
    thinkingTimedDurationMs: 0,
    samples: []
  };
}

function addTurnToTpsTracker(tracker, turn) {
  if (turn.durationMs > 0 && turn.outputTokens > 0 && turn.tps > 0) {
    tracker.timedTurns += 1;
    tracker.timedOutputTokens += turn.outputTokens;
    tracker.timedDurationMs += turn.durationMs;
    if (turn.outputTokens >= 30 && turn.tps > tracker.peakTps) {
      tracker.peakTps = turn.tps;
    } else if (tracker.peakTps === 0 && turn.tps > tracker.peakTps) {
      tracker.peakTps = turn.tps;
    }
    const ts = turn.timestamp ? Date.parse(turn.timestamp) : 0;
    tracker.samples.push({
      ts: Number.isNaN(ts) ? 0 : ts,
      tps: turn.tps,
      out: turn.outputTokens
    });
  }
  if (turn.thinkingDurationMs > 0 && turn.thinkingTokens > 0 && turn.thinkingTps > 0) {
    tracker.thinkingTimedTurns += 1;
    tracker.thinkingTimedTokens += turn.thinkingTokens;
    tracker.thinkingTimedDurationMs += turn.thinkingDurationMs;
  }
}

function finalizeTpsTracker(tracker, { includeTrend = false, maxTrendPoints = 20 } = {}) {
  const avgTps =
    tracker.timedDurationMs > 0
      ? Number((tracker.timedOutputTokens / (tracker.timedDurationMs / 1000)).toFixed(1))
      : 0;
  const avgThinkingTps =
    tracker.thinkingTimedDurationMs > 0
      ? Number((tracker.thinkingTimedTokens / (tracker.thinkingTimedDurationMs / 1000)).toFixed(1))
      : 0;
  const result = {
    timedTurns: tracker.timedTurns,
    avgTps,
    peakTps: Number(tracker.peakTps.toFixed(1)),
    avgThinkingTps
  };
  if (includeTrend) {
    const sorted = tracker.samples
      .slice()
      .sort((a, b) => a.ts - b.ts);
    const substantial = sorted.filter(s => s.out >= 15);
    const source = substantial.length >= 2 ? substantial : sorted;
    result.tpsTrend = source.slice(-maxTrendPoints).map(s => Number(s.tps.toFixed(1)));
  }
  return result;
}

function sumTurnMetrics(arr) {
  const tpsTracker = createTpsTracker();
  const base = arr.reduce(
    (acc, item) => {
      acc.turns += 1;
      acc.inputTokens += item.inputTokens;
      acc.cacheCreationTokens += item.cacheCreationTokens;
      acc.cacheReadTokens += item.cacheReadTokens;
      acc.outputTokens += item.outputTokens;
      acc.totalTokens +=
        item.inputTokens + item.cacheCreationTokens + item.cacheReadTokens + item.outputTokens;
      acc.costUsd += item.totalCostUsd;
      acc.cacheSavingsUsd += item.cacheSavingsUsd;
      addTurnToTpsTracker(tpsTracker, item);
      return acc;
    },
    {
      turns: 0,
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      cacheSavingsUsd: 0
    }
  );
  return { ...base, ...finalizeTpsTracker(tpsTracker) };
}

// 5. Compute subscription quota status + exact cycle boundaries for Claude & Antigravity
function computeClaudeQuota(allTurns, settings, liveQuotaEntry, officialHistory) {
  const nowMs = Date.now();
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const THIRTY_D_MS = 30 * 24 * 3600 * 1000;

  const sortedTurns = allTurns
    .map(t => ({ ...t, ts: Date.parse(t.timestamp) }))
    .filter(t => !Number.isNaN(t.ts))
    .sort((a, b) => a.ts - b.ts);

  const planCatalog = SUBSCRIPTION_PLANS.claude;
  const selectedPlanKey = settings.claudePlan || 'pro';
  const plan = planCatalog[selectedPlanKey] || planCatalog.pro;

  let fiveHourBudgetUsd = settings.customClaude5hUsd || plan.fiveHourBudgetUsd;
  let sevenDayBudgetUsd = plan.sevenDayBudgetUsd;

  const samples = officialHistory?.samples || [];
  let isOfficialLiveQuota = false;
  let quotaSourceLabel = '离散 5h/7d 周期测算 · 按 message.id 去重';

  let cycle5hStartMs = null;
  let fiveHourResetsAtMs = null;
  let fiveHourUsedPct = null;

  let cycle7dStartMs = null;
  let sevenDayResetsAtMs = null;
  let sevenDayUsedPct = null;

  // Step A: Use Claude Desktop official `plan-usage-history.json` if available
  if (samples.length > 0) {
    // 1. Calibrate 5-hour equivalent USD budget from historical 5h ramps (0% -> >=25%)
    if (!settings.customClaude5hUsd) {
      const rampBudgets = [];
      let rampStartMs = null;
      for (let i = 1; i < samples.length; i++) {
        if (samples[i - 1].u.fh === 0 && samples[i].u.fh > 0) {
          rampStartMs = samples[i - 1].t;
        }
        if (
          rampStartMs &&
          samples[i].u.fh >= 25 &&
          (i + 1 === samples.length || samples[i + 1].u.fh < samples[i].u.fh)
        ) {
          const c = sortedTurns
            .filter(t => t.ts >= rampStartMs && t.ts <= samples[i].t)
            .reduce((s, t) => s + t.totalCostUsd, 0);
          if (c > 1) {
            rampBudgets.push(c / (samples[i].u.fh / 100));
          }
          rampStartMs = null;
        }
      }
      if (rampBudgets.length >= 3) {
        rampBudgets.sort((a, b) => a - b);
        fiveHourBudgetUsd = Number(rampBudgets[Math.floor(rampBudgets.length / 2)].toFixed(2));
      }
    }

    // 2. Pinpoint exact current 7-day cycle boundary from `u.sd` resets
    let last7dResetIdx = 0;
    for (let i = 1; i < samples.length; i++) {
      const prevSd = samples[i - 1].u.sd;
      const currSd = samples[i].u.sd;
      if (typeof prevSd === 'number' && typeof currSd === 'number') {
        if (currSd < prevSd - 4 || (currSd === 0 && prevSd > 0)) {
          last7dResetIdx = i;
        }
      }
    }
    let start7dIdx = last7dResetIdx;
    while (
      start7dIdx + 1 < samples.length &&
      samples[start7dIdx].u.sd === 0 &&
      samples[start7dIdx + 1].u.sd === 0
    ) {
      start7dIdx++;
    }
    const raw7dAnchorMs =
      samples[start7dIdx].u.sd === 0
        ? samples[start7dIdx].t
        : samples[last7dResetIdx - 1]?.t || samples[last7dResetIdx].t;
    const candidate7dTurns = sortedTurns.filter(t => t.ts >= raw7dAnchorMs);
    cycle7dStartMs = candidate7dTurns[0]?.ts || raw7dAnchorMs;
    // If more than 7 days have passed since cycle7dStartMs without a new sample, roll forward by 7d steps
    while (nowMs >= cycle7dStartMs + SEVEN_D_MS) {
      cycle7dStartMs += SEVEN_D_MS;
    }
    sevenDayResetsAtMs = cycle7dStartMs + SEVEN_D_MS;

    const latestSample = samples.at(-1);
    if (latestSample.t >= cycle7dStartMs && typeof latestSample.u.sd === 'number') {
      const costAtSample7d = sortedTurns
        .filter(t => t.ts >= cycle7dStartMs && t.ts <= latestSample.t)
        .reduce((s, t) => s + t.totalCostUsd, 0);
      if (latestSample.u.sd >= 8 && costAtSample7d > 5) {
        sevenDayBudgetUsd = Number((costAtSample7d / (latestSample.u.sd / 100)).toFixed(2));
      }
      const deltaCostAfter7d = sortedTurns
        .filter(t => t.ts > latestSample.t)
        .reduce((s, t) => s + t.totalCostUsd, 0);
      sevenDayUsedPct = Math.min(
        100,
        latestSample.u.sd + (deltaCostAfter7d / sevenDayBudgetUsd) * 100
      );
      isOfficialLiveQuota = true;
    }

    // 3. Pinpoint exact current 5-hour cycle boundary from `u.fh` resets
    let last5hResetIdx = 0;
    for (let i = 1; i < samples.length; i++) {
      if (typeof samples[i].u.fh === 'number' && typeof samples[i - 1].u.fh === 'number') {
        if (samples[i].u.fh < samples[i - 1].u.fh) {
          last5hResetIdx = i;
        }
      }
    }
    let start5hIdx = last5hResetIdx;
    while (
      start5hIdx + 1 < samples.length &&
      samples[start5hIdx].u.fh === 0 &&
      samples[start5hIdx + 1].u.fh === 0
    ) {
      start5hIdx++;
    }
    const atResetSample = samples[start5hIdx];
    if (atResetSample.u.fh === 0) {
      const turnsAfterZero = sortedTurns.filter(t => t.ts >= atResetSample.t);
      cycle5hStartMs = turnsAfterZero[0]?.ts || null;
    } else {
      // Reset happened between samples[start5hIdx - 1].t and atResetSample.t
      const prevSampleT = samples[start5hIdx - 1]?.t || atResetSample.t - 15 * 60 * 1000;
      const targetInitialCost = (atResetSample.u.fh / 100) * fiveHourBudgetUsd;
      const intervalTurns = sortedTurns.filter(t => t.ts > prevSampleT && t.ts <= atResetSample.t);
      let accCost = 0;
      let chosenStart = atResetSample.t;
      for (let i = intervalTurns.length - 1; i >= 0; i--) {
        accCost += intervalTurns[i].totalCostUsd;
        chosenStart = intervalTurns[i].ts;
        if (accCost >= targetInitialCost * 1.35) break;
      }
      cycle5hStartMs = chosenStart;
    }

    // If the 5-hour cycle anchored by plan-usage-history is still active (nowMs < cycle5hStartMs + 5h):
    if (cycle5hStartMs && nowMs < cycle5hStartMs + FIVE_H_MS) {
      fiveHourResetsAtMs = cycle5hStartMs + FIVE_H_MS;
      if (latestSample.t >= cycle5hStartMs && typeof latestSample.u.fh === 'number') {
        const deltaCostAfter5h = sortedTurns
          .filter(t => t.ts > latestSample.t)
          .reduce((s, t) => s + t.totalCostUsd, 0);
        fiveHourUsedPct = Math.min(
          100,
          latestSample.u.fh + (deltaCostAfter5h / fiveHourBudgetUsd) * 100
        );
        isOfficialLiveQuota = true;
      }
    } else if (cycle5hStartMs) {
      // Previous 5h window expired after latestSample; step forward with discrete 5h windows
      const postExpiryTurns = sortedTurns.filter(t => t.ts >= cycle5hStartMs + FIVE_H_MS);
      const discrete = findDiscreteCycleWindow(postExpiryTurns, FIVE_H_MS, nowMs);
      cycle5hStartMs = discrete.cycleStartMs;
      fiveHourResetsAtMs = discrete.resetsAtMs;
      if (discrete.turnsInCycle.length === 0) {
        fiveHourUsedPct = 0;
        isOfficialLiveQuota = true;
      }
    }

    const sampleTimeStr = toLocalHMS(latestSample.t);
    quotaSourceLabel = `已直连 Claude Desktop 官方配额记录 (同步于 ${sampleTimeStr} ${getTzLabel()}) · 周期已对齐`;
  }

  // Step B: Override with Claude OAuth API or Claude Code statusLine live quota if fresher
  const parseResetTimestampMs = val => {
    if (!val) return NaN;
    if (typeof val === 'number') return val < 1e11 ? val * 1000 : val;
    const n = Number(val);
    if (!Number.isNaN(n) && String(val).trim() !== '') return n < 1e11 ? n * 1000 : n;
    return Date.parse(val);
  };

  if (liveQuotaEntry?.fiveHour?.resetsAt) {
    const resetMs = parseResetTimestampMs(liveQuotaEntry.fiveHour.resetsAt);
    if (!Number.isNaN(resetMs) && resetMs > nowMs) {
      fiveHourResetsAtMs = resetMs;
      cycle5hStartMs = resetMs - FIVE_H_MS;
      if (typeof liveQuotaEntry.fiveHour.usedPercentage === 'number') {
        fiveHourUsedPct = liveQuotaEntry.fiveHour.usedPercentage;
        isOfficialLiveQuota = true;
      }
    }
  }
  if (liveQuotaEntry?.sevenDay) {
    const sdEntry = liveQuotaEntry.sevenDay;
    const reset7dMs = parseResetTimestampMs(sdEntry.resetsAt);
    if (!Number.isNaN(reset7dMs)) {
      let effReset7dMs = reset7dMs;
      while (nowMs >= effReset7dMs) {
        effReset7dMs += SEVEN_D_MS;
      }
      const winStartMs = sdEntry.windowStartedAt ? Date.parse(sdEntry.windowStartedAt) : NaN;
      sevenDayResetsAtMs = effReset7dMs;
      cycle7dStartMs =
        !Number.isNaN(winStartMs) && effReset7dMs === reset7dMs
          ? winStartMs
          : effReset7dMs - SEVEN_D_MS;
    }
    if (typeof sdEntry.usedPercentage === 'number') {
      sevenDayUsedPct = sdEntry.usedPercentage;
      isOfficialLiveQuota = true;
    }
  }
  if (liveQuotaEntry?.source === 'claude_oauth_api' && isOfficialLiveQuota) {
    const syncTs = liveQuotaEntry.sevenDay?.asOf || liveQuotaEntry.updatedAt || new Date(nowMs).toISOString();
    quotaSourceLabel = `已直连 Claude 官方 OAuth 实时配额 (同步于 ${toLocalHMS(syncTs)} ${getTzLabel()}) · 周期已对齐`;
  } else if (liveQuotaEntry?.fiveHour?.usedPercentage != null || liveQuotaEntry?.sevenDay?.usedPercentage != null) {
    quotaSourceLabel = '已直连 Claude Code StatusLine 实时配额与重置周期';
  }

  // Step C: Fallback to discrete cycle windows if no official history
  if (!cycle5hStartMs) {
    const discrete5h = findDiscreteCycleWindow(sortedTurns, FIVE_H_MS, nowMs);
    cycle5hStartMs = discrete5h.cycleStartMs;
    fiveHourResetsAtMs = discrete5h.resetsAtMs;
  }
  if (!cycle7dStartMs) {
    const discrete7d = findDiscreteCycleWindow(sortedTurns, SEVEN_D_MS, nowMs);
    cycle7dStartMs = discrete7d.cycleStartMs;
    sevenDayResetsAtMs = discrete7d.resetsAtMs;
  }

  const turns5h = sortedTurns.filter(t => t.ts >= cycle5hStartMs);
  const turns7d = sortedTurns.filter(t => t.ts >= cycle7dStartMs);
  const turns30d = sortedTurns.filter(t => t.ts >= nowMs - THIRTY_D_MS);

  const stats5h = sumTurnMetrics(turns5h);
  const stats7d = sumTurnMetrics(turns7d);
  const stats30d = sumTurnMetrics(turns30d);

  // Calibrate 5h & 7d budgets against live official percentages when available
  if (!settings.customClaude5hUsd && isOfficialLiveQuota && typeof fiveHourUsedPct === 'number' && fiveHourUsedPct >= 15 && stats5h.costUsd > 2) {
    fiveHourBudgetUsd = Number((stats5h.costUsd / (fiveHourUsedPct / 100)).toFixed(2));
  }
  if (isOfficialLiveQuota && typeof sevenDayUsedPct === 'number' && sevenDayUsedPct >= 8 && stats7d.costUsd > 5) {
    sevenDayBudgetUsd = Number((stats7d.costUsd / (sevenDayUsedPct / 100)).toFixed(2));
  }

  if (fiveHourUsedPct === null) {
    fiveHourUsedPct = Math.min(100, (stats5h.costUsd / fiveHourBudgetUsd) * 100);
  }
  if (sevenDayUsedPct === null) {
    sevenDayUsedPct = Math.min(100, (stats7d.costUsd / sevenDayBudgetUsd) * 100);
  }

  const roiMultiplier = plan.monthlyPriceUsd > 0 ? stats30d.costUsd / plan.monthlyPriceUsd : 0;

  const dailyBreakdown = buildWeeklyDailyBreakdown({
    sortedTurns,
    cycle7dStartMs,
    sevenDayResetsAtMs,
    sevenDayUsedPct,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    nowMs,
    officialSamples: samples
  });

  return {
    platform: 'claude',
    planId: plan.id,
    planName: plan.name,
    monthlyPriceUsd: plan.monthlyPriceUsd,
    fiveHourBudgetUsd: Number(fiveHourBudgetUsd.toFixed(2)),
    sevenDayBudgetUsd: Number(sevenDayBudgetUsd.toFixed(2)),
    isOfficialLiveQuota,
    quotaSourceLabel,
    accountEmail: officialHistory?.accountInfo?.email || null,
    fiveHour: {
      ...stats5h,
      usedPercentage: Number(fiveHourUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - fiveHourUsedPct).toFixed(1)),
      cycleStartAt: new Date(cycle5hStartMs).toISOString(),
      resetsAt: fiveHourResetsAtMs ? new Date(fiveHourResetsAtMs).toISOString() : null
    },
    sevenDay: {
      ...stats7d,
      usedPercentage: Number(sevenDayUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - sevenDayUsedPct).toFixed(1)),
      cycleStartAt: new Date(cycle7dStartMs).toISOString(),
      resetsAt: sevenDayResetsAtMs ? new Date(sevenDayResetsAtMs).toISOString() : null,
      dailyBreakdown
    },
    thirtyDay: {
      ...stats30d,
      roiMultiplier: Number(roiMultiplier.toFixed(2)),
      roiPercentage: Math.round(roiMultiplier * 100)
    }
  };
}

function computeAntigravityQuota(allTurns, settings, liveQuotaEntry) {
  const nowMs = Date.now();
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const THIRTY_D_MS = 30 * 24 * 3600 * 1000;
  const START_GRACE_MS = 45 * 1000; // Include the triggering turn whose created_at precedes server stream-end resetTime by a few seconds

  const sortedTurns = allTurns
    .map(t => ({ ...t, ts: Date.parse(t.timestamp) }))
    .filter(t => !Number.isNaN(t.ts))
    .sort((a, b) => a.ts - b.ts);

  // Separate turns into Gemini native pool vs Third-Party (Claude & GPT) pool
  const isThirdPartyModel = m => /claude|gpt|opus|sonnet|haiku|fable/i.test(String(m || ''));
  const geminiTurns = sortedTurns.filter(t => !isThirdPartyModel(t.model));
  const thirdPartyTurns = sortedTurns.filter(t => isThirdPartyModel(t.model));

  const planCatalog = SUBSCRIPTION_PLANS.antigravity;
  let selectedPlanKey = settings.antigravityPlan || 'ultra5x';
  if (
    liveQuotaEntry?.userTierId === 'g1-ultra-lite-tier' &&
    selectedPlanKey === 'ultra'
  ) {
    selectedPlanKey = 'ultra5x';
  }
  const plan = planCatalog[selectedPlanKey] || planCatalog.ultra5x || Object.values(planCatalog)[0];

  let fiveHourBudgetUsd = settings.customAgy5hUsd || plan.fiveHourBudgetUsd;
  let sevenDayBudgetUsd = plan.sevenDayBudgetUsd;
  let thirdParty5hBudgetUsd = plan.thirdParty5hBudgetUsd || 15.6;
  let thirdParty7dBudgetUsd = plan.thirdParty7dBudgetUsd || 31.1;

  let isOfficialLiveQuota = false;
  let quotaSourceLabel = '离散 5h/7d 周期测算 · brain/*/transcript.jsonl';

  // --- 1. Gemini Models Pool (5h & 7d Weekly) ---
  let cycle5hStartMs = null;
  let fiveHourResetsAtMs = null;
  let fiveHourUsedPct = null;
  let fiveHourUsedExact = null;
  let fiveHourNativeRemPct = null;

  const gemini5hBucket = liveQuotaEntry?.pools?.gemini || liveQuotaEntry?.fiveHour;
  if (gemini5hBucket?.resetsAt) {
    const resetMs = Date.parse(gemini5hBucket.resetsAt);
    if (!Number.isNaN(resetMs) && resetMs > nowMs) {
      fiveHourResetsAtMs = resetMs;
      cycle5hStartMs = resetMs - FIVE_H_MS;
      if (typeof gemini5hBucket.usedPercentage === 'number') {
        fiveHourUsedPct = gemini5hBucket.usedPercentage;
        fiveHourUsedExact = gemini5hBucket.usedPercentageExact ?? gemini5hBucket.usedPercentage;
        fiveHourNativeRemPct =
          gemini5hBucket.nativeRemainingPct ?? Math.round(100 - fiveHourUsedPct);
        isOfficialLiveQuota = true;
        const tierTag = liveQuotaEntry.userTierId ? ` (${liveQuotaEntry.userTierId})` : '';
        quotaSourceLabel = `已直连 Antigravity LanguageServer 官方配额${tierTag} · 含 Gemini 与 Claude/GPT 双池`;
      }
    }
  }
  if (!cycle5hStartMs) {
    const discrete5h = findDiscreteCycleWindow(geminiTurns, FIVE_H_MS, nowMs);
    cycle5hStartMs = discrete5h.cycleStartMs;
    fiveHourResetsAtMs = discrete5h.resetsAtMs;
  }

  let cycle7dStartMs = null;
  let sevenDayResetsAtMs = null;
  let sevenDayUsedPct = null;
  let sevenDayUsedExact = null;
  let sevenDayNativeRemPct = null;

  const geminiWeeklyBucket = liveQuotaEntry?.pools?.geminiWeekly;
  if (geminiWeeklyBucket?.resetsAt) {
    const reset7dMs = Date.parse(geminiWeeklyBucket.resetsAt);
    if (!Number.isNaN(reset7dMs) && reset7dMs > nowMs) {
      sevenDayResetsAtMs = reset7dMs;
      cycle7dStartMs = reset7dMs - SEVEN_D_MS;
      if (typeof geminiWeeklyBucket.usedPercentage === 'number') {
        sevenDayUsedPct = geminiWeeklyBucket.usedPercentage;
        sevenDayUsedExact =
          geminiWeeklyBucket.usedPercentageExact ?? geminiWeeklyBucket.usedPercentage;
        sevenDayNativeRemPct =
          geminiWeeklyBucket.nativeRemainingPct ?? Math.round(100 - sevenDayUsedPct);
      }
    }
  }
  if (!cycle7dStartMs) {
    const discrete7d = findDiscreteCycleWindow(geminiTurns, SEVEN_D_MS, nowMs);
    cycle7dStartMs = discrete7d.cycleStartMs;
    sevenDayResetsAtMs = discrete7d.resetsAtMs;
  }

  const turns5h = geminiTurns.filter(t => t.ts >= cycle5hStartMs - START_GRACE_MS);
  const turns7d = geminiTurns.filter(t => t.ts >= cycle7dStartMs - START_GRACE_MS);
  const turns30d = sortedTurns.filter(t => t.ts >= nowMs - THIRTY_D_MS);

  const stats5h = sumTurnMetrics(turns5h);
  const stats7d = sumTurnMetrics(turns7d);
  const stats30d = sumTurnMetrics(turns30d);

  // Auto-calibrate Gemini 5h & 7d budgets from official usedPercentage + local costUsd
  if (
    !settings.customAgy5hUsd &&
    isOfficialLiveQuota &&
    fiveHourUsedExact >= 3 &&
    stats5h.costUsd >= 0.5
  ) {
    fiveHourBudgetUsd = Number((stats5h.costUsd / (fiveHourUsedExact / 100)).toFixed(2));
  }
  if (isOfficialLiveQuota && sevenDayUsedExact >= 2 && stats7d.costUsd >= 0.5) {
    sevenDayBudgetUsd = Number((stats7d.costUsd / (sevenDayUsedExact / 100)).toFixed(2));
  }

  if (fiveHourUsedPct === null) {
    fiveHourUsedPct = Math.min(100, (stats5h.costUsd / fiveHourBudgetUsd) * 100);
    fiveHourNativeRemPct = Math.round(Math.max(0, 100 - fiveHourUsedPct));
  }
  if (sevenDayUsedPct === null) {
    sevenDayUsedPct = Math.min(100, (stats7d.costUsd / sevenDayBudgetUsd) * 100);
    sevenDayNativeRemPct = Math.round(Math.max(0, 100 - sevenDayUsedPct));
  }

  // --- 2. Third-Party Pool ("Claude and GPT models": 5h & 7d Weekly) ---
  let tp5hStartMs = null;
  let tp5hResetsAtMs = null;
  let tp5hUsedPct = null;
  let tp5hUsedExact = null;
  let tp5hNativeRemPct = null;

  const tp5hBucket = liveQuotaEntry?.pools?.claude;
  if (tp5hBucket?.resetsAt) {
    const resetMs = Date.parse(tp5hBucket.resetsAt);
    if (!Number.isNaN(resetMs) && resetMs > nowMs) {
      tp5hResetsAtMs = resetMs;
      tp5hStartMs = resetMs - FIVE_H_MS;
      if (typeof tp5hBucket.usedPercentage === 'number') {
        tp5hUsedPct = tp5hBucket.usedPercentage;
        tp5hUsedExact = tp5hBucket.usedPercentageExact ?? tp5hBucket.usedPercentage;
        tp5hNativeRemPct = tp5hBucket.nativeRemainingPct ?? Math.round(100 - tp5hUsedPct);
      }
    }
  }
  if (!tp5hStartMs) {
    const discreteTp5h = findDiscreteCycleWindow(thirdPartyTurns, FIVE_H_MS, nowMs);
    tp5hStartMs = discreteTp5h.cycleStartMs;
    tp5hResetsAtMs = discreteTp5h.resetsAtMs;
  }

  let tp7dStartMs = null;
  let tp7dResetsAtMs = null;
  let tp7dUsedPct = null;
  let tp7dUsedExact = null;
  let tp7dNativeRemPct = null;

  const tpWeeklyBucket = liveQuotaEntry?.pools?.claudeWeekly;
  if (tpWeeklyBucket?.resetsAt) {
    const reset7dMs = Date.parse(tpWeeklyBucket.resetsAt);
    if (!Number.isNaN(reset7dMs) && reset7dMs > nowMs) {
      tp7dResetsAtMs = reset7dMs;
      tp7dStartMs = reset7dMs - SEVEN_D_MS;
      if (typeof tp7dUsedPct !== 'number' && typeof tpWeeklyBucket.usedPercentage === 'number') {
        tp7dUsedPct = tpWeeklyBucket.usedPercentage;
        tp7dUsedExact = tpWeeklyBucket.usedPercentageExact ?? tpWeeklyBucket.usedPercentage;
        tp7dNativeRemPct = tpWeeklyBucket.nativeRemainingPct ?? Math.round(100 - tp7dUsedPct);
      }
    }
  }
  if (!tp7dStartMs) {
    const discreteTp7d = findDiscreteCycleWindow(thirdPartyTurns, SEVEN_D_MS, nowMs);
    tp7dStartMs = discreteTp7d.cycleStartMs;
    tp7dResetsAtMs = discreteTp7d.resetsAtMs;
  }

  const tpTurns5h = thirdPartyTurns.filter(t => t.ts >= tp5hStartMs - START_GRACE_MS);
  const tpTurns7d = thirdPartyTurns.filter(t => t.ts >= tp7dStartMs - START_GRACE_MS);
  const tpStats5h = sumTurnMetrics(tpTurns5h);
  const tpStats7d = sumTurnMetrics(tpTurns7d);

  if (tp5hUsedExact >= 0.1 && tpStats5h.costUsd >= 0.01) {
    thirdParty5hBudgetUsd = Number((tpStats5h.costUsd / (tp5hUsedExact / 100)).toFixed(2));
  }
  if (tp7dUsedExact >= 0.05 && tpStats7d.costUsd >= 0.01) {
    thirdParty7dBudgetUsd = Number((tpStats7d.costUsd / (tp7dUsedExact / 100)).toFixed(2));
  }

  if (tp5hUsedPct === null) {
    tp5hUsedPct = Math.min(100, (tpStats5h.costUsd / thirdParty5hBudgetUsd) * 100);
    tp5hNativeRemPct = Math.round(Math.max(0, 100 - tp5hUsedPct));
  }
  if (tp7dUsedPct === null) {
    tp7dUsedPct = Math.min(100, (tpStats7d.costUsd / thirdParty7dBudgetUsd) * 100);
    tp7dNativeRemPct = Math.round(Math.max(0, 100 - tp7dUsedPct));
  }

  const roiMultiplier = plan.monthlyPriceUsd > 0 ? stats30d.costUsd / plan.monthlyPriceUsd : 0;

  const geminiDailyBreakdown = buildWeeklyDailyBreakdown({
    sortedTurns: geminiTurns,
    cycle7dStartMs,
    sevenDayResetsAtMs,
    sevenDayUsedPct,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    nowMs
  });

  const tpDailyBreakdown = buildWeeklyDailyBreakdown({
    sortedTurns: thirdPartyTurns,
    cycle7dStartMs: tp7dStartMs,
    sevenDayResetsAtMs: tp7dResetsAtMs,
    sevenDayUsedPct: tp7dUsedPct,
    sevenDayBudgetUsd: thirdParty7dBudgetUsd,
    fiveHourBudgetUsd: thirdParty5hBudgetUsd,
    nowMs
  });

  return {
    platform: 'antigravity',
    planId: plan.id,
    planName: plan.name,
    monthlyPriceUsd: plan.monthlyPriceUsd,
    fiveHourBudgetUsd: Number(fiveHourBudgetUsd.toFixed(2)),
    sevenDayBudgetUsd: Number(sevenDayBudgetUsd.toFixed(2)),
    thirdParty5hBudgetUsd: Number(thirdParty5hBudgetUsd.toFixed(2)),
    thirdParty7dBudgetUsd: Number(thirdParty7dBudgetUsd.toFixed(2)),
    isOfficialLiveQuota,
    quotaSourceLabel,
    accountEmail: liveQuotaEntry?.email || null,
    userTierId: liveQuotaEntry?.userTierId || null,
    pools: liveQuotaEntry?.pools || null,
    fiveHour: {
      ...stats5h,
      usedPercentage: Number(fiveHourUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - fiveHourUsedPct).toFixed(1)),
      nativeRemainingPct: fiveHourNativeRemPct,
      cycleStartAt: new Date(cycle5hStartMs).toISOString(),
      resetsAt: fiveHourResetsAtMs ? new Date(fiveHourResetsAtMs).toISOString() : null
    },
    sevenDay: {
      ...stats7d,
      usedPercentage: Number(sevenDayUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - sevenDayUsedPct).toFixed(1)),
      nativeRemainingPct: sevenDayNativeRemPct,
      cycleStartAt: new Date(cycle7dStartMs).toISOString(),
      resetsAt: sevenDayResetsAtMs ? new Date(sevenDayResetsAtMs).toISOString() : null,
      dailyBreakdown: geminiDailyBreakdown
    },
    thirdParty: {
      groupName: 'Claude and GPT models',
      modelsLabel: 'Claude Opus 5.5 · Claude Sonnet 5.5 · GPT-OSS 120B',
      fiveHourBudgetUsd: Number(thirdParty5hBudgetUsd.toFixed(2)),
      sevenDayBudgetUsd: Number(thirdParty7dBudgetUsd.toFixed(2)),
      fiveHour: {
        ...tpStats5h,
        usedPercentage: Number(tp5hUsedPct.toFixed(1)),
        remainingPercentage: Number(Math.max(0, 100 - tp5hUsedPct).toFixed(1)),
        nativeRemainingPct: tp5hNativeRemPct,
        cycleStartAt: new Date(tp5hStartMs).toISOString(),
        resetsAt: tp5hResetsAtMs ? new Date(tp5hResetsAtMs).toISOString() : null
      },
      sevenDay: {
        ...tpStats7d,
        usedPercentage: Number(tp7dUsedPct.toFixed(1)),
        remainingPercentage: Number(Math.max(0, 100 - tp7dUsedPct).toFixed(1)),
        nativeRemainingPct: tp7dNativeRemPct,
        cycleStartAt: new Date(tp7dStartMs).toISOString(),
        resetsAt: tp7dResetsAtMs ? new Date(tp7dResetsAtMs).toISOString() : null,
        dailyBreakdown: tpDailyBreakdown
      }
    },
    thirtyDay: {
      ...stats30d,
      roiMultiplier: Number(roiMultiplier.toFixed(2)),
      roiPercentage: Math.round(roiMultiplier * 100)
    }
  };
}

function computeGptQuota(allTurns, settings, liveQuotaEntry, codexAuthInfo, latestRolloutRateLimits = null) {
  const nowMs = Date.now();
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const THIRTY_D_MS = 30 * 24 * 3600 * 1000;

  const sortedTurns = allTurns
    .map(t => ({ ...t, ts: Date.parse(t.timestamp) }))
    .filter(t => !Number.isNaN(t.ts))
    .sort((a, b) => a.ts - b.ts);

  const planCatalog = SUBSCRIPTION_PLANS.gpt;
  const autoPlanKey =
    codexAuthInfo?.planType && planCatalog[codexAuthInfo.planType]
      ? codexAuthInfo.planType
      : null;
  const selectedPlanKey = settings.gptPlan || autoPlanKey || 'plus';
  const plan = planCatalog[selectedPlanKey] || planCatalog.plus;

  const fiveHourBudgetUsd = settings.customGpt5hUsd || plan.fiveHourBudgetUsd;
  const sevenDayBudgetUsd = plan.sevenDayBudgetUsd;

  let isOfficialLiveQuota = false;
  let quotaSourceLabel = codexAuthInfo?.email
    ? `已识别 ChatGPT ${(codexAuthInfo.planType || plan.id).toUpperCase()} 账号 (${codexAuthInfo.email}) · 5h/7d 周期测算`
    : '离散 5h/7d 周期测算 · Codex 本地日志';

  let cycle5hStartMs = null;
  let fiveHourResetsAtMs = null;
  let fiveHourUsedPct = null;

  let cycle7dStartMs = null;
  let sevenDayResetsAtMs = null;
  let sevenDayUsedPct = null;

  // Step A: Use rollout rate_limits if present & still active
  if (latestRolloutRateLimits) {
    const primary = latestRolloutRateLimits.primary;
    const secondary = latestRolloutRateLimits.secondary;
    if (primary && typeof primary.used_percent === 'number') {
      const resetMs = primary.resets_at ? Number(primary.resets_at) * 1000 : null;
      if (resetMs && resetMs > nowMs) {
        fiveHourResetsAtMs = resetMs;
        cycle5hStartMs = resetMs - FIVE_H_MS;
        fiveHourUsedPct = Number(primary.used_percent);
        isOfficialLiveQuota = true;
        quotaSourceLabel = '已直连 Codex 官方实时配额与重置周期';
      }
    }
    if (secondary && typeof secondary.used_percent === 'number') {
      const reset7dMs = secondary.resets_at ? Number(secondary.resets_at) * 1000 : null;
      if (reset7dMs && reset7dMs > nowMs) {
        sevenDayResetsAtMs = reset7dMs;
        cycle7dStartMs = reset7dMs - SEVEN_D_MS;
        sevenDayUsedPct = Number(secondary.used_percent);
        isOfficialLiveQuota = true;
      }
    }
  }

  // Step B: Override with live_quota.json (`gpt`) if fresher
  if (liveQuotaEntry?.fiveHour?.resetsAt) {
    const resetMs =
      typeof liveQuotaEntry.fiveHour.resetsAt === 'number'
        ? liveQuotaEntry.fiveHour.resetsAt * 1000
        : Date.parse(liveQuotaEntry.fiveHour.resetsAt);
    if (!Number.isNaN(resetMs) && resetMs > nowMs) {
      fiveHourResetsAtMs = resetMs;
      cycle5hStartMs = resetMs - FIVE_H_MS;
      if (typeof liveQuotaEntry.fiveHour.usedPercentage === 'number') {
        fiveHourUsedPct = liveQuotaEntry.fiveHour.usedPercentage;
        isOfficialLiveQuota = true;
        quotaSourceLabel = '已直连 Codex Hook 实时配额与重置周期';
      }
    }
  }
  if (liveQuotaEntry?.sevenDay?.usedPercentage != null) {
    sevenDayUsedPct = liveQuotaEntry.sevenDay.usedPercentage;
  }

  // Step C: Fallback to discrete 5h / 7d cycle windows
  if (!cycle5hStartMs) {
    const discrete5h = findDiscreteCycleWindow(sortedTurns, FIVE_H_MS, nowMs);
    cycle5hStartMs = discrete5h.cycleStartMs;
    fiveHourResetsAtMs = discrete5h.resetsAtMs;
  }
  if (!cycle7dStartMs) {
    const discrete7d = findDiscreteCycleWindow(sortedTurns, SEVEN_D_MS, nowMs);
    cycle7dStartMs = discrete7d.cycleStartMs;
    sevenDayResetsAtMs = discrete7d.resetsAtMs;
  }

  const turns5h = sortedTurns.filter(t => t.ts >= cycle5hStartMs);
  const turns7d = sortedTurns.filter(t => t.ts >= cycle7dStartMs);
  const turns30d = sortedTurns.filter(t => t.ts >= nowMs - THIRTY_D_MS);

  const stats5h = sumTurnMetrics(turns5h);
  const stats7d = sumTurnMetrics(turns7d);
  const stats30d = sumTurnMetrics(turns30d);

  if (fiveHourUsedPct === null) {
    fiveHourUsedPct = Math.min(100, (stats5h.costUsd / fiveHourBudgetUsd) * 100);
  }
  if (sevenDayUsedPct === null) {
    sevenDayUsedPct = Math.min(100, (stats7d.costUsd / sevenDayBudgetUsd) * 100);
  }

  const roiMultiplier = plan.monthlyPriceUsd > 0 ? stats30d.costUsd / plan.monthlyPriceUsd : 0;

  const dailyBreakdown = buildWeeklyDailyBreakdown({
    sortedTurns,
    cycle7dStartMs,
    sevenDayResetsAtMs,
    sevenDayUsedPct,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    nowMs
  });

  return {
    platform: 'gpt',
    planId: plan.id,
    planName: plan.name,
    monthlyPriceUsd: plan.monthlyPriceUsd,
    fiveHourBudgetUsd: Number(fiveHourBudgetUsd.toFixed(2)),
    sevenDayBudgetUsd: Number(sevenDayBudgetUsd.toFixed(2)),
    isOfficialLiveQuota,
    quotaSourceLabel,
    accountEmail: codexAuthInfo?.email || null,
    subscriptionUntil: codexAuthInfo?.subscriptionUntil || null,
    fiveHour: {
      ...stats5h,
      usedPercentage: Number(fiveHourUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - fiveHourUsedPct).toFixed(1)),
      cycleStartAt: new Date(cycle5hStartMs).toISOString(),
      resetsAt: fiveHourResetsAtMs ? new Date(fiveHourResetsAtMs).toISOString() : null
    },
    sevenDay: {
      ...stats7d,
      usedPercentage: Number(sevenDayUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - sevenDayUsedPct).toFixed(1)),
      cycleStartAt: new Date(cycle7dStartMs).toISOString(),
      resetsAt: sevenDayResetsAtMs ? new Date(sevenDayResetsAtMs).toISOString() : null,
      dailyBreakdown
    },
    thirtyDay: {
      ...stats30d,
      roiMultiplier: Number(roiMultiplier.toFixed(2)),
      roiPercentage: Math.round(roiMultiplier * 100)
    }
  };
}

export function getModelRegistrySummary() {
  return describeRegistry(
    Object.keys(activePricing.MODEL_PRICING || {}),
    activePricing.isKnownModel || (() => false)
  );
}

export async function getDashboardSnapshot({ days = 30, tz = null } = {}) {
  const startPerf = performance.now();
  await refreshPricingModule();
  const settings = loadUserSettings();
  activeTimezoneId = normalizeTimezoneId(tz || settings.timezone || 'Asia/Shanghai');

  // Fetch live Antigravity quota from local language_server.exe RPC (if running) + Claude OAuth live quota + load Claude official history + Codex auth
  await Promise.all([
    fetchAntigravityOfficialQuota(),
    fetchClaudeOfficialOAuthQuota()
  ]);
  const liveQuota = loadLiveQuota();
  const claudeOfficialHistory = loadClaudeOfficialPlanUsage();
  const codexAuthInfo = loadCodexAuthInfo();

  const claudeSessions = scanAllClaudeSessions();
  const agySessions = scanAllAntigravitySessions();
  const gptSessions = scanAllGptSessions();
  flushDiskCache();
  const allSessions = [...claudeSessions, ...agySessions, ...gptSessions];

  // Dynamically refresh turn pricing & model labels from latest pricing rules
  const seenModelNames = new Set();
  for (const session of allSessions) {
    if (!Array.isArray(session.turns)) continue;
    for (const t of session.turns) {
      const cost = calculateTurnCost(t);
      Object.assign(t, cost);
      if (t.model) seenModelNames.add(t.model);
    }
  }
  // Record models that are not in the static pricing table so they show up in `cli models`
  try {
    if (typeof activePricing.isKnownModel === 'function') {
      noteSeenModels(seenModelNames, activePricing.isKnownModel);
    }
  } catch {}

  const allClaudeTurns = claudeSessions.flatMap(s => s.turns);
  const allAgyTurns = agySessions.flatMap(s => s.turns);
  const allGptTurns = gptSessions.flatMap(s => s.turns);

  let latestGptRateLimits = null;
  for (const s of gptSessions) {
    if (s.latestRateLimits) {
      if (!latestGptRateLimits || (s.latestRateLimits.timestamp || '') > (latestGptRateLimits.timestamp || '')) {
        latestGptRateLimits = s.latestRateLimits;
      }
    }
  }

  // Quota calculations with exact cycle alignment & official quota calibration
  const quotaStatus = {
    claude: computeClaudeQuota(allClaudeTurns, settings, liveQuota.claude, claudeOfficialHistory),
    antigravity: computeAntigravityQuota(allAgyTurns, settings, liveQuota.antigravity),
    gpt: computeGptQuota(allGptTurns, settings, liveQuota.gpt, codexAuthInfo, latestGptRateLimits)
  };

  // Date range filter for dashboard charts & tables (using activeTimezoneId)
  const nowMs = Date.now();
  const todayStartMs = getTzDayStartMs(nowMs);
  const todayDateStr = toLocalDateStr(nowMs);

  const cutoffMs =
    days === 'all' || !days
      ? 0
      : days === 'today' || Number(days) === 1
      ? todayStartMs
      : nowMs - Number(days) * 24 * 3600 * 1000;

  const totals = {
    claude: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 },
    antigravity: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 },
    gpt: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 },
    combined: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 }
  };
  const totalsTpsTrackers = {
    claude: createTpsTracker(),
    antigravity: createTpsTracker(),
    gpt: createTpsTracker(),
    combined: createTpsTracker()
  };

  // Dedicated Today's real-time statistics (00:00 UTC+8 -> now)
  const todayTotals = {
    date: todayDateStr,
    claude: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 },
    antigravity: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0, geminiTurns: 0, geminiCostUsd: 0, thirdPartyTurns: 0, thirdPartyCostUsd: 0 },
    gpt: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 },
    combined: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 }
  };
  const todayTpsTrackers = {
    claude: createTpsTracker(),
    antigravity: createTpsTracker(),
    gpt: createTpsTracker(),
    combined: createTpsTracker()
  };
  const todayModelMap = new Map();

  for (const session of allSessions) {
    const todayTurns = session.turns.filter(t => {
      const ts = Date.parse(t.timestamp);
      return !Number.isNaN(ts) && ts >= todayStartMs;
    });
    if (todayTurns.length > 0) {
      todayTotals[session.platform].sessions += 1;
      todayTotals.combined.sessions += 1;
      for (const t of todayTurns) {
        const tokSum = t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens + t.outputTokens;
        const pT = todayTotals[t.platform];
        pT.turns += 1;
        pT.inputTokens += t.inputTokens;
        pT.cacheWriteTokens += t.cacheCreationTokens;
        pT.cacheReadTokens += t.cacheReadTokens;
        pT.outputTokens += t.outputTokens;
        pT.totalTokens += tokSum;
        pT.costUsd += t.totalCostUsd;
        pT.cacheSavingsUsd += t.cacheSavingsUsd;
        addTurnToTpsTracker(todayTpsTrackers[t.platform], t);

        if (t.platform === 'antigravity') {
          if (/claude|gpt|opus|sonnet|haiku|fable/i.test(String(t.model || ''))) {
            pT.thirdPartyTurns += 1;
            pT.thirdPartyCostUsd += t.totalCostUsd;
          } else {
            pT.geminiTurns += 1;
            pT.geminiCostUsd += t.totalCostUsd;
          }
        }

        todayTotals.combined.turns += 1;
        todayTotals.combined.inputTokens += t.inputTokens;
        todayTotals.combined.cacheWriteTokens += t.cacheCreationTokens;
        todayTotals.combined.cacheReadTokens += t.cacheReadTokens;
        todayTotals.combined.outputTokens += t.outputTokens;
        todayTotals.combined.totalTokens += tokSum;
        todayTotals.combined.costUsd += t.totalCostUsd;
        todayTotals.combined.cacheSavingsUsd += t.cacheSavingsUsd;
        addTurnToTpsTracker(todayTpsTrackers.combined, t);

        const mKey = `${t.platform}:${t.modelLabel}`;
        if (!todayModelMap.has(mKey)) {
          todayModelMap.set(mKey, {
            key: mKey,
            platform: t.platform,
            model: t.modelLabel,
            turns: 0,
            inputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            cacheSavingsUsd: 0,
            tpsTracker: createTpsTracker()
          });
        }
        const mE = todayModelMap.get(mKey);
        mE.turns += 1;
        mE.inputTokens += t.inputTokens;
        mE.cacheWriteTokens += t.cacheCreationTokens;
        mE.cacheReadTokens += t.cacheReadTokens;
        mE.outputTokens += t.outputTokens;
        mE.totalTokens += tokSum;
        mE.costUsd += t.totalCostUsd;
        mE.cacheSavingsUsd += t.cacheSavingsUsd;
        addTurnToTpsTracker(mE.tpsTracker, t);
      }
    }
  }
  Object.assign(todayTotals.claude, finalizeTpsTracker(todayTpsTrackers.claude));
  Object.assign(todayTotals.antigravity, finalizeTpsTracker(todayTpsTrackers.antigravity));
  Object.assign(todayTotals.gpt, finalizeTpsTracker(todayTpsTrackers.gpt));
  Object.assign(todayTotals.combined, finalizeTpsTracker(todayTpsTrackers.combined));
  todayTotals.models = Array.from(todayModelMap.values())
    .map(({ tpsTracker, ...m }) => {
      const pool = m.inputTokens + m.cacheWriteTokens + m.cacheReadTokens;
      return {
        ...m,
        ...finalizeTpsTracker(tpsTracker, { includeTrend: true }),
        cacheHitRate: pool > 0 ? Number(((m.cacheReadTokens / pool) * 100).toFixed(1)) : 0,
        sharePct:
          todayTotals.combined.costUsd > 0
            ? Number(((m.costUsd / todayTotals.combined.costUsd) * 100).toFixed(1))
            : 0
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  const dailyMap = new Map();
  const annualDailyMap = new Map();
  const annualCutoffMs = Date.now() - 370 * 86400_000;
  for (const session of allSessions) {
    for (const t of session.turns) {
      const ts = Date.parse(t.timestamp);
      if (Number.isNaN(ts) || ts < annualCutoffMs) continue;
      const dayKey = toLocalDateStr(ts);
      if (!dayKey) continue;
      if (!annualDailyMap.has(dayKey)) {
        annualDailyMap.set(dayKey, {
          date: dayKey,
          claudeTokens: 0,
          agyTokens: 0,
          gptTokens: 0,
          claudeCostUsd: 0,
          agyCostUsd: 0,
          gptCostUsd: 0,
          claudeTurns: 0,
          agyTurns: 0,
          gptTurns: 0
        });
      }
      const entry = annualDailyMap.get(dayKey);
      const tokSum = t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens + t.outputTokens;
      if (t.platform === 'claude') {
        entry.claudeTokens += tokSum;
        entry.claudeCostUsd += t.totalCostUsd;
        entry.claudeTurns += 1;
      } else if (t.platform === 'gpt') {
        entry.gptTokens += tokSum;
        entry.gptCostUsd += t.totalCostUsd;
        entry.gptTurns += 1;
      } else {
        entry.agyTokens += tokSum;
        entry.agyCostUsd += t.totalCostUsd;
        entry.agyTurns += 1;
      }
    }
  }
  const annualDailySeries = Array.from(annualDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const modelMap = new Map();
  const projectMap = new Map();
  const hourlyCounts = Array.from({ length: 24 }, (_, h) => ({ hour: h, claudeTurns: 0, agyTurns: 0, gptTurns: 0, tokens: 0 }));
  const filteredSessions = [];

  for (const session of allSessions) {
    const turnsInWindow = session.turns.filter(t => {
      const ts = Date.parse(t.timestamp);
      return Number.isNaN(ts) || ts >= cutoffMs;
    });
    if (turnsInWindow.length === 0) continue;

    let sInput = 0, sCacheWrite = 0, sCacheRead = 0, sOutput = 0, sCost = 0, sSavings = 0;
    const sessionModels = new Set();
    const sessionTpsTracker = createTpsTracker();

    for (const t of turnsInWindow) {
      const pTarget = totals[t.platform];
      const tokSum = t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens + t.outputTokens;

      pTarget.turns += 1;
      pTarget.inputTokens += t.inputTokens;
      pTarget.cacheWriteTokens += t.cacheCreationTokens;
      pTarget.cacheReadTokens += t.cacheReadTokens;
      pTarget.outputTokens += t.outputTokens;
      pTarget.totalTokens += tokSum;
      pTarget.costUsd += t.totalCostUsd;
      pTarget.cacheSavingsUsd += t.cacheSavingsUsd;
      addTurnToTpsTracker(totalsTpsTrackers[t.platform], t);

      totals.combined.turns += 1;
      totals.combined.inputTokens += t.inputTokens;
      totals.combined.cacheWriteTokens += t.cacheCreationTokens;
      totals.combined.cacheReadTokens += t.cacheReadTokens;
      totals.combined.outputTokens += t.outputTokens;
      totals.combined.totalTokens += tokSum;
      totals.combined.costUsd += t.totalCostUsd;
      totals.combined.cacheSavingsUsd += t.cacheSavingsUsd;
      addTurnToTpsTracker(totalsTpsTrackers.combined, t);

      sInput += t.inputTokens;
      sCacheWrite += t.cacheCreationTokens;
      sCacheRead += t.cacheReadTokens;
      sOutput += t.outputTokens;
      sCost += t.totalCostUsd;
      sSavings += t.cacheSavingsUsd;
      sessionModels.add(t.modelLabel || t.model);
      addTurnToTpsTracker(sessionTpsTracker, t);

      // Daily aggregation in UTC+8 (东八区 date string YYYY-MM-DD)
      const ts = Date.parse(t.timestamp);
      if (!Number.isNaN(ts)) {
        const dayKey = toLocalDateStr(ts);
        if (!dailyMap.has(dayKey)) {
          dailyMap.set(dayKey, {
            date: dayKey,
            claudeTokens: 0,
            agyTokens: 0,
            gptTokens: 0,
            claudeCostUsd: 0,
            agyCostUsd: 0,
            gptCostUsd: 0,
            claudeTurns: 0,
            agyTurns: 0,
            gptTurns: 0,
            claudeTpsTracker: createTpsTracker(),
            agyTpsTracker: createTpsTracker(),
            gptTpsTracker: createTpsTracker()
          });
        }
        const dayEntry = dailyMap.get(dayKey);
        if (t.platform === 'claude') {
          dayEntry.claudeTokens += tokSum;
          dayEntry.claudeCostUsd += t.totalCostUsd;
          dayEntry.claudeTurns += 1;
          addTurnToTpsTracker(dayEntry.claudeTpsTracker, t);
        } else if (t.platform === 'gpt') {
          dayEntry.gptTokens += tokSum;
          dayEntry.gptCostUsd += t.totalCostUsd;
          dayEntry.gptTurns += 1;
          addTurnToTpsTracker(dayEntry.gptTpsTracker, t);
        } else {
          dayEntry.agyTokens += tokSum;
          dayEntry.agyCostUsd += t.totalCostUsd;
          dayEntry.agyTurns += 1;
          addTurnToTpsTracker(dayEntry.agyTpsTracker, t);
        }

        const hr = getTzHour(ts);
        if (t.platform === 'claude') hourlyCounts[hr].claudeTurns += 1;
        else if (t.platform === 'gpt') hourlyCounts[hr].gptTurns += 1;
        else hourlyCounts[hr].agyTurns += 1;
        hourlyCounts[hr].tokens += tokSum;
      }

      // Model aggregation
      const mKey = `${t.platform}:${t.modelLabel}`;
      if (!modelMap.has(mKey)) {
        modelMap.set(mKey, {
          key: mKey,
          platform: t.platform,
          model: t.modelLabel,
          family: t.modelFamily,
          turns: 0,
          inputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          cacheSavingsUsd: 0,
          tpsTracker: createTpsTracker()
        });
      }
      const mEntry = modelMap.get(mKey);
      mEntry.turns += 1;
      mEntry.inputTokens += t.inputTokens;
      mEntry.cacheWriteTokens += t.cacheCreationTokens;
      mEntry.cacheReadTokens += t.cacheReadTokens;
      mEntry.outputTokens += t.outputTokens;
      mEntry.totalTokens += tokSum;
      mEntry.costUsd += t.totalCostUsd;
      mEntry.cacheSavingsUsd += t.cacheSavingsUsd;
      addTurnToTpsTracker(mEntry.tpsTracker, t);
    }

    totals[session.platform].sessions += 1;
    totals.combined.sessions += 1;

    // Project aggregation
    const projKey = session.projectLabel || '未指定工作区 (Global)';
    if (!projectMap.has(projKey)) {
      projectMap.set(projKey, {
        projectLabel: projKey,
        projectPath: session.projectPath || '',
        platforms: new Set(),
        sessionsCount: 0,
        turns: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        cacheSavingsUsd: 0,
        lastActive: session.lastTimestamp
      });
    }
    const pEntry = projectMap.get(projKey);
    pEntry.platforms.add(session.surface);
    pEntry.sessionsCount += 1;
    pEntry.turns += turnsInWindow.length;
    pEntry.inputTokens += sInput + sCacheWrite;
    pEntry.cacheReadTokens += sCacheRead;
    pEntry.outputTokens += sOutput;
    pEntry.totalTokens += sInput + sCacheWrite + sCacheRead + sOutput;
    pEntry.costUsd += sCost;
    pEntry.cacheSavingsUsd += sSavings;
    if (session.lastTimestamp > pEntry.lastActive) {
      pEntry.lastActive = session.lastTimestamp;
    }

    const totalInputPool = sInput + sCacheWrite + sCacheRead;
    const cacheHitRate = totalInputPool > 0 ? (sCacheRead / totalInputPool) * 100 : 0;

    filteredSessions.push({
      sessionId: session.sessionId,
      platform: session.platform,
      surface: session.surface,
      title: session.title,
      projectLabel: session.projectLabel,
      projectPath: session.projectPath,
      isSubagent: Boolean(session.isSubagent),
      models: Array.from(sessionModels),
      turnsCount: turnsInWindow.length,
      inputTokens: sInput,
      cacheWriteTokens: sCacheWrite,
      cacheReadTokens: sCacheRead,
      outputTokens: sOutput,
      totalTokens: sInput + sCacheWrite + sCacheRead + sOutput,
      cacheHitRate: Number(cacheHitRate.toFixed(1)),
      costUsd: Number(sCost.toFixed(4)),
      cacheSavingsUsd: Number(sSavings.toFixed(4)),
      ...finalizeTpsTracker(sessionTpsTracker),
      firstTimestamp: session.firstTimestamp,
      lastTimestamp: session.lastTimestamp
    });
  }

  Object.assign(totals.claude, finalizeTpsTracker(totalsTpsTrackers.claude));
  Object.assign(totals.antigravity, finalizeTpsTracker(totalsTpsTrackers.antigravity));
  Object.assign(totals.gpt, finalizeTpsTracker(totalsTpsTrackers.gpt));
  Object.assign(totals.combined, finalizeTpsTracker(totalsTpsTrackers.combined));

  const dailySeries = Array.from(dailyMap.values())
    .map(({ claudeTpsTracker, agyTpsTracker, gptTpsTracker, ...d }) => {
      const cTps = finalizeTpsTracker(claudeTpsTracker);
      const aTps = finalizeTpsTracker(agyTpsTracker);
      const gTps = finalizeTpsTracker(gptTpsTracker);
      return {
        ...d,
        claudeAvgTps: cTps.avgTps,
        claudePeakTps: cTps.peakTps,
        agyAvgTps: aTps.avgTps,
        agyPeakTps: aTps.peakTps,
        gptAvgTps: gTps.avgTps,
        gptPeakTps: gTps.peakTps
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const models = Array.from(modelMap.values())
    .map(({ tpsTracker, ...m }) => {
      const pool = m.inputTokens + m.cacheWriteTokens + m.cacheReadTokens;
      return {
        ...m,
        ...finalizeTpsTracker(tpsTracker, { includeTrend: true }),
        cacheHitRate: pool > 0 ? Number(((m.cacheReadTokens / pool) * 100).toFixed(1)) : 0,
        sharePct: totals.combined.costUsd > 0 ? Number(((m.costUsd / totals.combined.costUsd) * 100).toFixed(1)) : 0
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  const projects = Array.from(projectMap.values())
    .map(p => {
      const pool = p.inputTokens + p.cacheReadTokens;
      return {
        ...p,
        platforms: Array.from(p.platforms),
        cacheHitRate: pool > 0 ? Number(((p.cacheReadTokens / pool) * 100).toFixed(1)) : 0
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd);

  filteredSessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));

  const scanDurationMs = Number((performance.now() - startPerf).toFixed(1));

  return {
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    timezone: activeTimezoneId,
    timezoneLabel: getTzLabel(activeTimezoneId),
    scanDurationMs,
    daysFilter: days,
    settings,
    plansCatalog: SUBSCRIPTION_PLANS,
    quotaStatus,
    todayStats: todayTotals,
    totals,
    dailySeries,
    annualDailySeries,
    hourlyCounts,
    models,
    modelRegistry: getModelRegistrySummary(),
    projects: projects.slice(0, 50),
    recentSessions: filteredSessions.slice(0, 100)
  };
}
