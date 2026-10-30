import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { calculateTurnCost, SUBSCRIPTION_PLANS, PRICING_VERSION } from './pricing.mjs';

const HOME = os.homedir();
const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LIVE_QUOTA_FILE = path.join(DATA_DIR, 'live_quota.json');
const DISK_CACHE_FILE = path.join(DATA_DIR, 'parsed_cache.json');

// Incremental file parse cache: filePath -> { mtimeMs, size, pricingVersion, data }
const fileCache = new Map();
let cacheDirty = false;

// In-memory cache for Antigravity language_server.exe CSRF token by PID
let cachedLsAuth = { pid: null, httpPort: null, csrfToken: null, checkedAt: 0 };

try {
  if (fs.existsSync(DISK_CACHE_FILE)) {
    const rawCache = JSON.parse(fs.readFileSync(DISK_CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(rawCache)) {
      if (v && v.pricingVersion === PRICING_VERSION) {
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
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch {}
  return {
    claudePlan: 'pro',          // 'pro' | 'max5x' | 'max20x'
    antigravityPlan: 'ultra5x', // 'pro' | 'ultra5x' | 'ultra'
    customClaude5hUsd: null,
    customAgy5hUsd: null
  };
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
      return JSON.parse(fs.readFileSync(LIVE_QUOTA_FILE, 'utf8'));
    }
  } catch {}
  return { claude: null, antigravity: null };
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
    cached.pricingVersion === PRICING_VERSION
  ) {
    return cached.data;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  // Deduplicate turns by message.id (Claude Code writes multiple streaming lines per API turn)
  const turnMap = new Map();
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
      if (obj.timestamp) {
        if (!firstTimestamp || obj.timestamp < firstTimestamp) firstTimestamp = obj.timestamp;
        if (!lastTimestamp || obj.timestamp > lastTimestamp) lastTimestamp = obj.timestamp;
      }

      if (!firstUserPrompt && obj.type === 'user' && obj.message?.content) {
        if (typeof obj.message.content === 'string') {
          firstUserPrompt = cleanUserPreview(obj.message.content);
        } else if (Array.isArray(obj.message.content)) {
          const textBlock = obj.message.content.find(b => b.type === 'text' && b.text);
          if (textBlock) firstUserPrompt = cleanUserPreview(textBlock.text);
        }
      }

      const msg = obj.message;
      if (msg && msg.usage && msg.model && msg.model !== '<synthetic>') {
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
          toolCallsCount: Array.isArray(msg.content)
            ? msg.content.filter(c => c.type === 'tool_use').length
            : 0
        });
      }
    } catch {}
  }

  const turns = Array.from(turnMap.values()).map(t => {
    const cost = calculateTurnCost(t);
    return { ...t, ...cost };
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
    pricingVersion: PRICING_VERSION,
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

function parseAntigravityTranscript(filePath, stat, convId, surfaceLabel, meta = {}) {
  const cacheKey = `${filePath}:${meta.title || ''}:${meta.workspacePath || ''}`;
  const cached = fileCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.pricingVersion === PRICING_VERSION &&
    !cached.data?.turns?.some(t => String(t.model).startsWith('(['))
  ) {
    return cached.data;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  let activeModel = 'Gemini 4 Argon (High)';
  let firstUserPrompt = '';
  let firstTimestamp = null;
  let lastTimestamp = null;
  let workspaceFromLogs = meta.workspacePath || '';
  const turns = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.created_at) {
        if (!firstTimestamp || obj.created_at < firstTimestamp) firstTimestamp = obj.created_at;
        if (!lastTimestamp || obj.created_at > lastTimestamp) lastTimestamp = obj.created_at;
      }

      if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
        const modelMatch = obj.content.match(
          /<USER_SETTINGS_CHANGE>[\s\S]*?Model Selection` from .*? to ([^\r\n<]+?)(?:\.\s+No need|\.\s*$|\r?\n|<)/i
        );
        if (modelMatch) {
          activeModel = modelMatch[1].trim();
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

        if (!workspaceFromLogs && Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const p = tc.args?.Path || tc.args?.CommandLine || '';
            const m = String(p).match(/([A-Za-z]:\\+[^"'\s\\]+\\+[^"'\s\\]+(?:\\+[^"'\s\\]+)?)/);
            if (m && !/\\(Users|Windows|Program Files|AppData)\\/i.test(m[1])) {
              workspaceFromLogs = m[1].replace(/\\\\/g, '\\');
              break;
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
          toolCallsCount: Array.isArray(obj.tool_calls) ? obj.tool_calls.length : 0
        };
        const cost = calculateTurnCost(turnBase);
        turns.push({ ...turnBase, ...cost });
      }
    } catch {}
  }

  const finalWorkspace = meta.workspacePath || workspaceFromLogs;
  const data = {
    sessionId: convId,
    platform: 'antigravity',
    surface: surfaceLabel,
    projectPath: finalWorkspace,
    projectLabel: formatWorkspaceLabel(finalWorkspace),
    title: meta.title || firstUserPrompt || `Antigravity ${convId.slice(0, 8)}`,
    isSubagent: Boolean(meta.parentConversationId),
    parentConversationId: meta.parentConversationId || null,
    firstTimestamp: firstTimestamp || new Date(stat.mtimeMs).toISOString(),
    lastTimestamp: lastTimestamp || new Date(stat.mtimeMs).toISOString(),
    turns
  };

  fileCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pricingVersion: PRICING_VERSION,
    data
  });
  cacheDirty = true;
  return data;
}

function scanAllAntigravitySessions() {
  const surfaces = [
    { dir: 'antigravity', label: 'Antigravity 2.0' },
    { dir: 'antigravity-cli', label: 'Antigravity CLI' },
    { dir: 'antigravity-ide', label: 'Antigravity IDE' }
  ];

  const sessions = [];
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
      const transcriptPath = path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;
      try {
        const stat = fs.statSync(transcriptPath);
        const meta = summaryMap.get(convId) || {};
        const parsed = parseAntigravityTranscript(transcriptPath, stat, convId, s.label, meta);
        if (parsed.turns.length > 0) {
          sessions.push(parsed);
        }
      } catch {}
    }
  }

  return sessions;
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

// 4. Official Local Quota Discovery: Antigravity `language_server.exe` RPC (`GetUserStatus`)
async function fetchAntigravityOfficialQuota() {
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

function sumTurnMetrics(arr) {
  return arr.reduce(
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

    const sampleTimeStr = new Date(latestSample.t).toLocaleTimeString();
    quotaSourceLabel = `已直连 Claude Desktop 官方配额记录 (同步于 ${sampleTimeStr}) · 周期已对齐`;
  }

  // Step B: Override with Claude Code statusLine live hook if fresher
  if (liveQuotaEntry?.fiveHour?.resetsAt) {
    const resetMs = Number(liveQuotaEntry.fiveHour.resetsAt) * 1000;
    if (resetMs > nowMs) {
      fiveHourResetsAtMs = resetMs;
      cycle5hStartMs = resetMs - FIVE_H_MS;
      if (typeof liveQuotaEntry.fiveHour.usedPercentage === 'number') {
        fiveHourUsedPct = liveQuotaEntry.fiveHour.usedPercentage;
        isOfficialLiveQuota = true;
        quotaSourceLabel = '已直连 Claude Code StatusLine 实时配额与重置周期';
      }
    }
  }
  if (liveQuotaEntry?.sevenDay?.usedPercentage != null) {
    sevenDayUsedPct = liveQuotaEntry.sevenDay.usedPercentage;
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

  if (fiveHourUsedPct === null) {
    fiveHourUsedPct = Math.min(100, (stats5h.costUsd / fiveHourBudgetUsd) * 100);
  }
  if (sevenDayUsedPct === null) {
    sevenDayUsedPct = Math.min(100, (stats7d.costUsd / sevenDayBudgetUsd) * 100);
  }

  const roiMultiplier = plan.monthlyPriceUsd > 0 ? stats30d.costUsd / plan.monthlyPriceUsd : 0;

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
      resetsAt: sevenDayResetsAtMs ? new Date(sevenDayResetsAtMs).toISOString() : null
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
      resetsAt: sevenDayResetsAtMs ? new Date(sevenDayResetsAtMs).toISOString() : null
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
        resetsAt: tp7dResetsAtMs ? new Date(tp7dResetsAtMs).toISOString() : null
      }
    },
    thirtyDay: {
      ...stats30d,
      roiMultiplier: Number(roiMultiplier.toFixed(2)),
      roiPercentage: Math.round(roiMultiplier * 100)
    }
  };
}

export async function getDashboardSnapshot({ days = 30 } = {}) {
  const startPerf = performance.now();
  const settings = loadUserSettings();

  // Fetch live Antigravity quota from local language_server.exe RPC (if running) + load Claude official history
  await fetchAntigravityOfficialQuota();
  const liveQuota = loadLiveQuota();
  const claudeOfficialHistory = loadClaudeOfficialPlanUsage();

  const claudeSessions = scanAllClaudeSessions();
  const agySessions = scanAllAntigravitySessions();
  flushDiskCache();
  const allSessions = [...claudeSessions, ...agySessions];

  const allClaudeTurns = claudeSessions.flatMap(s => s.turns);
  const allAgyTurns = agySessions.flatMap(s => s.turns);

  // Quota calculations with exact cycle alignment & official quota calibration
  const quotaStatus = {
    claude: computeClaudeQuota(allClaudeTurns, settings, liveQuota.claude, claudeOfficialHistory),
    antigravity: computeAntigravityQuota(allAgyTurns, settings, liveQuota.antigravity)
  };

  // Date range filter for dashboard charts & tables
  const nowMs = Date.now();
  const nowObj = new Date(nowMs);
  const todayStartMs = new Date(
    nowObj.getFullYear(),
    nowObj.getMonth(),
    nowObj.getDate(),
    0,
    0,
    0,
    0
  ).getTime();
  const todayDateStr = `${nowObj.getFullYear()}-${String(nowObj.getMonth() + 1).padStart(2, '0')}-${String(nowObj.getDate()).padStart(2, '0')}`;

  const cutoffMs =
    days === 'all' || !days
      ? 0
      : days === 'today' || Number(days) === 1
      ? todayStartMs
      : nowMs - Number(days) * 24 * 3600 * 1000;

  const totals = {
    claude: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 },
    antigravity: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 },
    combined: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 }
  };

  // Dedicated Today's real-time statistics (00:00 local time -> now)
  const todayTotals = {
    date: todayDateStr,
    claude: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 },
    antigravity: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0, geminiTurns: 0, geminiCostUsd: 0, thirdPartyTurns: 0, thirdPartyCostUsd: 0 },
    combined: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0 }
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
            cacheSavingsUsd: 0
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
      }
    }
  }
  todayTotals.models = Array.from(todayModelMap.values())
    .map(m => {
      const pool = m.inputTokens + m.cacheWriteTokens + m.cacheReadTokens;
      return {
        ...m,
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
      const dObj = new Date(t.timestamp);
      const ts = dObj.getTime();
      if (Number.isNaN(ts) || ts < annualCutoffMs) continue;
      const yyyy = dObj.getFullYear();
      const mm = String(dObj.getMonth() + 1).padStart(2, '0');
      const dd = String(dObj.getDate()).padStart(2, '0');
      const dayKey = `${yyyy}-${mm}-${dd}`;
      if (!annualDailyMap.has(dayKey)) {
        annualDailyMap.set(dayKey, {
          date: dayKey,
          claudeTokens: 0,
          agyTokens: 0,
          claudeCostUsd: 0,
          agyCostUsd: 0,
          claudeTurns: 0,
          agyTurns: 0
        });
      }
      const entry = annualDailyMap.get(dayKey);
      const tokSum = t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens + t.outputTokens;
      if (t.platform === 'claude') {
        entry.claudeTokens += tokSum;
        entry.claudeCostUsd += t.totalCostUsd;
        entry.claudeTurns += 1;
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
  const hourlyCounts = Array.from({ length: 24 }, (_, h) => ({ hour: h, claudeTurns: 0, agyTurns: 0, tokens: 0 }));
  const filteredSessions = [];

  for (const session of allSessions) {
    const turnsInWindow = session.turns.filter(t => {
      const ts = Date.parse(t.timestamp);
      return Number.isNaN(ts) || ts >= cutoffMs;
    });
    if (turnsInWindow.length === 0) continue;

    let sInput = 0, sCacheWrite = 0, sCacheRead = 0, sOutput = 0, sCost = 0, sSavings = 0;
    const sessionModels = new Set();

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

      totals.combined.turns += 1;
      totals.combined.inputTokens += t.inputTokens;
      totals.combined.cacheWriteTokens += t.cacheCreationTokens;
      totals.combined.cacheReadTokens += t.cacheReadTokens;
      totals.combined.outputTokens += t.outputTokens;
      totals.combined.totalTokens += tokSum;
      totals.combined.costUsd += t.totalCostUsd;
      totals.combined.cacheSavingsUsd += t.cacheSavingsUsd;

      sInput += t.inputTokens;
      sCacheWrite += t.cacheCreationTokens;
      sCacheRead += t.cacheReadTokens;
      sOutput += t.outputTokens;
      sCost += t.totalCostUsd;
      sSavings += t.cacheSavingsUsd;
      sessionModels.add(t.modelLabel || t.model);

      // Daily aggregation (local date string YYYY-MM-DD)
      const dObj = new Date(t.timestamp);
      if (!Number.isNaN(dObj.getTime())) {
        const yyyy = dObj.getFullYear();
        const mm = String(dObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dObj.getDate()).padStart(2, '0');
        const dayKey = `${yyyy}-${mm}-${dd}`;
        if (!dailyMap.has(dayKey)) {
          dailyMap.set(dayKey, {
            date: dayKey,
            claudeTokens: 0,
            agyTokens: 0,
            claudeCostUsd: 0,
            agyCostUsd: 0,
            claudeTurns: 0,
            agyTurns: 0
          });
        }
        const dayEntry = dailyMap.get(dayKey);
        if (t.platform === 'claude') {
          dayEntry.claudeTokens += tokSum;
          dayEntry.claudeCostUsd += t.totalCostUsd;
          dayEntry.claudeTurns += 1;
        } else {
          dayEntry.agyTokens += tokSum;
          dayEntry.agyCostUsd += t.totalCostUsd;
          dayEntry.agyTurns += 1;
        }

        const hr = dObj.getHours();
        if (t.platform === 'claude') hourlyCounts[hr].claudeTurns += 1;
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
          cacheSavingsUsd: 0
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
      firstTimestamp: session.firstTimestamp,
      lastTimestamp: session.lastTimestamp
    });
  }

  const dailySeries = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const models = Array.from(modelMap.values())
    .map(m => {
      const pool = m.inputTokens + m.cacheWriteTokens + m.cacheReadTokens;
      return {
        ...m,
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
    generatedAt: new Date().toISOString(),
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
    projects: projects.slice(0, 50),
    recentSessions: filteredSessions.slice(0, 100)
  };
}
