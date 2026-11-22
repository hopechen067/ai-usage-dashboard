import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import * as staticPricing from './pricing.mjs';
import { SUBSCRIPTION_PLANS, PRICING_VERSION } from './pricing.mjs';
import { syncRpcModels, noteSeenModels, describeRegistry } from './model-registry.mjs';

const execFileAsync = promisify(execFile);

const PRICING_MODULE_PATH = path.resolve(import.meta.dirname, 'pricing.mjs');
let activePricing = staticPricing;
let lastPricingMtimeMs = 0;

// Incremental file parse cache: filePath -> { mtimeMs, size, pricingVersion, ..., data }
let ENGINE_VERSION = staticPricing.PRICING_VERSION;
const CLAUDE_PARSER_VERSION = 5;
const CODEX_PARSER_VERSION = 8;
const AGY_PARSER_VERSION = 7;
const fileCache = new Map();
const logFileCache = new Map();
const dirtyCacheKeys = new Set();
const dirtyLogKeys = new Set();
let diskCacheLoaded = false;
let cacheDb = null;

async function refreshPricingModule() {
  try {
    const mtimeMs = fs.statSync(PRICING_MODULE_PATH).mtimeMs;
    if (mtimeMs !== lastPricingMtimeMs) {
      lastPricingMtimeMs = mtimeMs;
      activePricing = await import(`${pathToFileURL(PRICING_MODULE_PATH).href}?v=${Date.now()}`);
      ENGINE_VERSION = activePricing.PRICING_VERSION || ENGINE_VERSION;
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
const QUOTA_HISTORY_FILE = path.join(DATA_DIR, 'quota_history.json');
const QUOTA_RESETS_FILE = path.join(DATA_DIR, 'quota_resets.json');
const DISK_CACHE_FILE = path.join(DATA_DIR, 'parsed_cache.json');
const SQLITE_CACHE_FILE = path.join(DATA_DIR, 'parsed_cache.sqlite');

// In-memory cache for Antigravity language_server daemon discovery
let cachedLsAuth = { pid: null, httpPort: null, csrfToken: null, lsVersion: null, checkedAt: 0 };
let cachedLsLogMeta = { mtimeMs: 0, size: 0, pid: null, httpPort: null };
// In-memory throttle cache for official live quota polling
let cachedAgyOfficialQuota = { checkedAt: 0, payload: null };
let cachedClaudeOAuthQuota = { checkedAt: 0, payload: null };
let cachedCodexOfficialQuota = { checkedAt: 0, payload: null };

// Live quota sync diagnostics per platform
const quotaSyncDiagnostics = {
  antigravity: { status: 'unknown', source: null, syncedAt: null, reason: '' },
  claude: { status: 'unknown', source: null, syncedAt: null, reason: '' },
  gpt: { status: 'unknown', source: null, syncedAt: null, reason: '' }
};

// Short-TTL in-memory scan caches + single-flight deduplication
const scanStateCache = {
  claude: { scannedAt: 0, sessions: null, fileMeta: new Map() },
  antigravity: {
    scannedAt: 0,
    sessions: null,
    summaries: new Map(), // surfaceRoot -> { sig, map }
    fileMeta: new Map(),  // filePath -> { checkedAt, mtimeMs, size, dbSig }
    logIndexMemo: new Map() // surfaceRoot -> { checkedAt, map }
  },
  gpt: { scannedAt: 0, sessions: null, fileMeta: new Map() }
};
const inFlightSnapshots = new Map();
const memoizedHeavyAgg = {
  tierAllSig: '',
  tierAll: null,
  annualSig: '',
  annualSeries: null,
  lastSnapshots: new Map() // key -> { createdAt, dataSig, snapshot }
};

function parseResetTimestampMs(val) {
  if (val === null || val === undefined || val === '') return NaN;
  if (typeof val === 'number') return val < 1e11 ? val * 1000 : val;
  const n = Number(val);
  if (!Number.isNaN(n) && String(val).trim() !== '') return n < 1e11 ? n * 1000 : n;
  return Date.parse(val);
}

function hydrateSessionData(data, pricingVersion = ENGINE_VERSION) {
  if (!data) return data;
  const hydrateOne = sess => {
    if (!sess || !Array.isArray(sess.turns)) return sess;
    const plat = sess.platform;
    const surf = sess.surface;
    const sid = sess.sessionId;
    for (let i = 0; i < sess.turns.length; i++) {
      const t = sess.turns[i];
      if (!t.platform && plat) t.platform = plat;
      if (!t.surface && surf) t.surface = surf;
      if (!t.sessionId && sid) t.sessionId = sid;
      if (t._ts === undefined) {
        const parsed = Date.parse(t.timestamp);
        t._ts = Number.isNaN(parsed) ? NaN : parsed;
      }
      t.ts = t._ts;
      if (t._pricedVer === undefined && typeof t.totalCostUsd === 'number' && t.modelLabel) {
        t._pricedVer = pricingVersion;
      }
    }
    return sess;
  };
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) hydrateOne(data[i]);
    return data;
  }
  return hydrateOne(data);
}

function compactSessionForCache(data) {
  const compactOne = sess => {
    if (!sess || !Array.isArray(sess.turns)) return sess;
    const compactTurns = sess.turns.map(t => {
      const out = {};
      for (const [k, v] of Object.entries(t)) {
        if (k === '_ts' || k === 'ts' || k === '_pricedVer') continue;
        if (k === 'platform' && v === sess.platform) continue;
        if (k === 'surface' && v === sess.surface) continue;
        if (k === 'sessionId' && v === sess.sessionId) continue;
        if (v === null || v === undefined) continue;
        out[k] = v;
      }
      return out;
    });
    return { ...sess, turns: compactTurns };
  };
  if (Array.isArray(data)) return data.map(compactOne);
  return compactOne(data);
}

function openCacheDb() {
  if (cacheDb) return cacheDb;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(SQLITE_CACHE_FILE);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS file_cache (
      key TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      pricing_ver INTEGER NOT NULL,
      parser_ver INTEGER NOT NULL DEFAULT 0,
      db_sig TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS log_cache (
      path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  cacheDb = db;
  return db;
}

function setFileCacheEntry(key, entry) {
  hydrateSessionData(entry.data, entry.pricingVersion || ENGINE_VERSION);
  fileCache.set(key, entry);
  dirtyCacheKeys.add(key);
}

function setLogCacheEntry(logPath, entry) {
  logFileCache.set(logPath, entry);
  dirtyLogKeys.add(logPath);
}

function ensureDiskCacheLoaded() {
  if (diskCacheLoaded) return;
  diskCacheLoaded = true;
  try {
    const db = openCacheDb();
    const rows = db.prepare('SELECT key, mtime_ms, size, pricing_ver, parser_ver, db_sig, payload FROM file_cache').all();
    for (const r of rows) {
      if (r.pricing_ver !== ENGINE_VERSION) continue;
      try {
        const data = hydrateSessionData(JSON.parse(r.payload), r.pricing_ver);
        const entry = {
          mtimeMs: r.mtime_ms,
          size: r.size,
          pricingVersion: r.pricing_ver,
          dbSig: r.db_sig || '',
          data
        };
        if (r.key.startsWith('codex_')) entry.codexParserVersion = r.parser_ver;
        else if (r.key.includes('transcript.jsonl')) entry.agyParserVersion = r.parser_ver;
        else entry.claudeParserVersion = r.parser_ver;
        fileCache.set(r.key, entry);
      } catch {}
    }

    const logRows = db.prepare('SELECT path, mtime_ms, size, payload FROM log_cache').all();
    for (const r of logRows) {
      try {
        logFileCache.set(r.path, {
          mtimeMs: r.mtime_ms,
          size: r.size,
          entries: JSON.parse(r.payload)
        });
      } catch {}
    }

    // One-time automatic migration from legacy monolithic parsed_cache.json -> incremental SQLite cache
    if (rows.length === 0 && fs.existsSync(DISK_CACHE_FILE)) {
      try {
        const rawCache = JSON.parse(fs.readFileSync(DISK_CACHE_FILE, 'utf8'));
        const deduped = new Map();
        for (const [origKey, v] of Object.entries(rawCache)) {
          if (!v || v.pricingVersion !== ENGINE_VERSION || !v.data) continue;
          let normKey = origKey;
          const agyIdx = origKey.indexOf('transcript.jsonl:');
          if (agyIdx > 0) {
            normKey = origKey.slice(0, agyIdx + 'transcript.jsonl'.length);
          }
          const prev = deduped.get(normKey);
          if (!prev || (v.mtimeMs || 0) >= (prev.mtimeMs || 0)) {
            deduped.set(normKey, v);
          }
        }
        for (const [k, v] of deduped.entries()) {
          hydrateSessionData(v.data, v.pricingVersion);
          fileCache.set(k, v);
          dirtyCacheKeys.add(k);
        }
        flushDiskCache();
        try {
          fs.unlinkSync(DISK_CACHE_FILE);
        } catch {}
      } catch {}
    }
  } catch {}
}

function flushDiskCache() {
  if (dirtyCacheKeys.size === 0 && dirtyLogKeys.size === 0) return;
  try {
    const db = openCacheDb();
    const upsertFile = db.prepare(`
      INSERT INTO file_cache (key, mtime_ms, size, pricing_ver, parser_ver, db_sig, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        pricing_ver = excluded.pricing_ver,
        parser_ver = excluded.parser_ver,
        db_sig = excluded.db_sig,
        payload = excluded.payload
    `);
    const upsertLog = db.prepare(`
      INSERT INTO log_cache (path, mtime_ms, size, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        mtime_ms = excluded.mtime_ms,
        size = excluded.size,
        payload = excluded.payload
    `);
    db.exec('BEGIN');
    try {
      for (const key of dirtyCacheKeys) {
        const entry = fileCache.get(key);
        if (!entry) continue;
        const parserVer =
          entry.agyParserVersion ?? entry.codexParserVersion ?? entry.claudeParserVersion ?? 0;
        const compact = compactSessionForCache(entry.data);
        upsertFile.run(
          key,
          Number(entry.mtimeMs || 0),
          Number(entry.size || 0),
          Number(entry.pricingVersion || ENGINE_VERSION),
          Number(parserVer || 0),
          String(entry.dbSig || ''),
          JSON.stringify(compact)
        );
      }
      for (const logPath of dirtyLogKeys) {
        const entry = logFileCache.get(logPath);
        if (!entry) continue;
        upsertLog.run(
          logPath,
          Number(entry.mtimeMs || 0),
          Number(entry.size || 0),
          JSON.stringify(entry.entries || [])
        );
      }
      db.exec('COMMIT');
      dirtyCacheKeys.clear();
      dirtyLogKeys.clear();
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }
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

const WEEKLY_POOL_KEYS = ['claude', 'gpt', 'agy-gemini', 'agy-tp'];
const SEVEN_D_MS_CONST = 7 * 24 * 3600 * 1000;
const FIVE_H_MS_CONST = 5 * 3600 * 1000;
const CLUSTER_TOLERANCE_MS_CONST = 15 * 60 * 1000;

function makeEmptyQuotaResets() {
  return {
    pools: {
      claude: { activeOverride: null, events: [], observed: null, fiveHourObserved: null, fiveHourEvents: [], lastAnchorResetsAt: null },
      gpt: { activeOverride: null, events: [], observed: null, fiveHourObserved: null, fiveHourEvents: [], lastAnchorResetsAt: null },
      'agy-gemini': { activeOverride: null, events: [], observed: null, fiveHourObserved: null, fiveHourEvents: [], lastAnchorResetsAt: null },
      'agy-tp': { activeOverride: null, events: [], observed: null, fiveHourObserved: null, fiveHourEvents: [], lastAnchorResetsAt: null }
    }
  };
}

export function loadQuotaResets() {
  const base = makeEmptyQuotaResets();
  try {
    if (fs.existsSync(QUOTA_RESETS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(QUOTA_RESETS_FILE, 'utf8'));
      const rawPools = parsed?.pools || {};
      for (const k of WEEKLY_POOL_KEYS) {
        if (rawPools[k] && typeof rawPools[k] === 'object') {
          base.pools[k] = {
            activeOverride: rawPools[k].activeOverride || null,
            events: Array.isArray(rawPools[k].events) ? rawPools[k].events : [],
            observed: rawPools[k].observed || null,
            fiveHourObserved: rawPools[k].fiveHourObserved || null,
            fiveHourEvents: Array.isArray(rawPools[k].fiveHourEvents) ? rawPools[k].fiveHourEvents : [],
            lastAnchorResetsAt: rawPools[k].lastAnchorResetsAt || null
          };
        }
      }
    }
  } catch {}
  return base;
}

function saveQuotaResets(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${QUOTA_RESETS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, QUOTA_RESETS_FILE);
  } catch {
    try {
      fs.writeFileSync(QUOTA_RESETS_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
  }
}

function saveQuotaHistory(history) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${QUOTA_HISTORY_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(tmp, QUOTA_HISTORY_FILE);
  } catch {
    try {
      fs.writeFileSync(QUOTA_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    } catch {}
  }
}

// Collapse redundant consecutive 0% rolling placeholder entries (e.g. Antigravity idle 7d sliding resetTime)
function sanitizeQuotaHistory(history) {
  let dirty = false;
  for (const k of WEEKLY_POOL_KEYS) {
    const list = Array.isArray(history[k]) ? history[k] : [];
    if (list.length <= 1) continue;
    list.sort((a, b) => (parseResetTimestampMs(a.resetsAt) || 0) - (parseResetTimestampMs(b.resetsAt) || 0));
    const cleaned = [];
    for (const item of list) {
      if (!item || !item.resetsAt) {
        dirty = true;
        continue;
      }
      const prev = cleaned.at(-1);
      const currResetMs = parseResetTimestampMs(item.resetsAt);
      const prevResetMs = prev ? parseResetTimestampMs(prev.resetsAt) : NaN;
      const bothZeroIdle =
        prev &&
        !prev.isResetArchive &&
        !item.isResetArchive &&
        !prev.resetMode &&
        !item.resetMode &&
        Number(prev.usedPercentage || 0) === 0 &&
        Number(item.usedPercentage || 0) === 0 &&
        !Number.isNaN(currResetMs) &&
        !Number.isNaN(prevResetMs) &&
        currResetMs >= prevResetMs &&
        currResetMs - prevResetMs < 6.5 * DAY_MS;
      if (bothZeroIdle) {
        cleaned[cleaned.length - 1] = item;
        dirty = true;
      } else {
        cleaned.push(item);
      }
    }
    if (cleaned.length !== list.length) {
      history[k] = cleaned;
    }
  }
  return dirty;
}

export function loadQuotaHistory() {
  const empty = { claude: [], gpt: [], 'agy-gemini': [], 'agy-tp': [] };
  try {
    if (fs.existsSync(QUOTA_HISTORY_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(QUOTA_HISTORY_FILE, 'utf8'));
      const history = {
        claude: Array.isArray(parsed.claude) ? parsed.claude : [],
        gpt: Array.isArray(parsed.gpt) ? parsed.gpt : [],
        'agy-gemini': Array.isArray(parsed['agy-gemini']) ? parsed['agy-gemini'] : [],
        'agy-tp': Array.isArray(parsed['agy-tp']) ? parsed['agy-tp'] : []
      };
      if (sanitizeQuotaHistory(history)) {
        saveQuotaHistory(history);
      }
      return history;
    }
  } catch {}
  return empty;
}

function upsertQuotaHistoryBucket(list, entry) {
  if (!entry || !entry.resetsAt || typeof entry.usedPercentage !== 'number') return false;
  const resetMs = parseResetTimestampMs(entry.resetsAt);
  if (Number.isNaN(resetMs)) return false;

  const isArchiveEntry = Boolean(entry.isResetArchive);
  let existing = null;
  if (entry.resetEventId) {
    existing = list.find(item => item.resetEventId === entry.resetEventId);
  }
  if (!existing && !isArchiveEntry) {
    existing = list.find(item => {
      if (item.isResetArchive) return false;
      const itemResetMs = parseResetTimestampMs(item.resetsAt);
      return !Number.isNaN(itemResetMs) && Math.abs(itemResetMs - resetMs) <= CLUSTER_TOLERANCE_MS_CONST;
    });
  }

  // Merge sliding 0% idle window instead of appending duplicate 0% entries
  if (!existing && !isArchiveEntry && Number(entry.usedPercentage || 0) === 0) {
    const lastOpen = [...list].reverse().find(item => !item.isResetArchive && !item.resetMode);
    if (lastOpen && Number(lastOpen.usedPercentage || 0) === 0) {
      const lastResetMs = parseResetTimestampMs(lastOpen.resetsAt);
      if (!Number.isNaN(lastResetMs) && Math.abs(resetMs - lastResetMs) < 6.5 * 24 * 3600 * 1000) {
        const nextIso = new Date(resetMs).toISOString();
        const nextStart = entry.cycleStartAt || new Date(resetMs - SEVEN_D_MS_CONST).toISOString();
        if (lastOpen.resetsAt === nextIso && lastOpen.cycleStartAt === nextStart && lastOpen.asOf === entry.asOf) {
          return false;
        }
        lastOpen.cycleStartAt = nextStart;
        lastOpen.resetsAt = nextIso;
        if (entry.naturalResetsAt) lastOpen.naturalResetsAt = entry.naturalResetsAt;
        if (entry.asOf) lastOpen.asOf = entry.asOf;
        if (entry.source) lastOpen.source = entry.source;
        list.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
        return true;
      }
    }
  }

  if (existing) {
    const nextUsed = entry.forceReplaceUsedPct
      ? Number(entry.usedPercentage)
      : Math.max(Number(existing.usedPercentage || 0), Number(entry.usedPercentage));
    const nextAsOf =
      entry.asOf && (!existing.asOf || entry.asOf >= existing.asOf) ? entry.asOf : existing.asOf;
    const nextStart = entry.cycleStartAt || existing.cycleStartAt;
    const nextNatural = entry.naturalResetsAt || existing.naturalResetsAt || null;
    const changed =
      Number(nextUsed.toFixed(2)) !== Number(existing.usedPercentage) ||
      nextAsOf !== existing.asOf ||
      nextStart !== existing.cycleStartAt ||
      (nextNatural && nextNatural !== existing.naturalResetsAt) ||
      Boolean(entry.isResetArchive) !== Boolean(existing.isResetArchive) ||
      (entry.resetMode && entry.resetMode !== existing.resetMode);
    if (!changed) return false;
    existing.usedPercentage = Number(nextUsed.toFixed(2));
    if (nextStart) existing.cycleStartAt = nextStart;
    if (entry.resetsAt) existing.resetsAt = new Date(resetMs).toISOString();
    if (nextNatural) existing.naturalResetsAt = nextNatural;
    if (nextAsOf) existing.asOf = nextAsOf;
    if (entry.source) existing.source = entry.source;
    if (entry.isResetArchive !== undefined) existing.isResetArchive = Boolean(entry.isResetArchive);
    if (entry.resetMode) existing.resetMode = entry.resetMode;
    if (entry.resetSource) existing.resetSource = entry.resetSource;
    if (entry.resetEventId) existing.resetEventId = entry.resetEventId;
    list.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
    return true;
  }

  const row = {
    cycleStartAt: entry.cycleStartAt || new Date(resetMs - SEVEN_D_MS_CONST).toISOString(),
    resetsAt: new Date(resetMs).toISOString(),
    usedPercentage: Number(Number(entry.usedPercentage).toFixed(2)),
    asOf: entry.asOf || new Date().toISOString(),
    source: entry.source || 'official'
  };
  if (entry.naturalResetsAt) row.naturalResetsAt = entry.naturalResetsAt;
  if (entry.isResetArchive) row.isResetArchive = true;
  if (entry.resetMode) row.resetMode = entry.resetMode;
  if (entry.resetSource) row.resetSource = entry.resetSource;
  if (entry.resetEventId) row.resetEventId = entry.resetEventId;
  if (entry.id) row.id = entry.id;

  list.push(row);
  list.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
  return true;
}

function sealCycleSegmentToHistory(list, {
  archiveStartMs,
  archiveEndMs,
  naturalResetsAtMs,
  usedPct,
  mode,
  resetSource,
  eventId,
  sourceLabel,
  existingNatResetToReplaceMs = null
}) {
  if (!Number.isFinite(archiveStartMs) || !Number.isFinite(archiveEndMs) || archiveEndMs <= archiveStartMs + 5_000) {
    return { dirty: false, replacedBackup: null, historyId: null };
  }
  const natIso = Number.isFinite(naturalResetsAtMs) ? new Date(naturalResetsAtMs).toISOString() : null;
  const endIso = new Date(archiveEndMs).toISOString();
  const startIso = new Date(archiveStartMs).toISOString();
  const historyId = `hist_${eventId}`;

  // If there is an open (unsealed) history entry for the same natural reset window, seal it in-place
  let openIdx = -1;
  if (Number.isFinite(existingNatResetToReplaceMs)) {
    openIdx = list.findIndex(item => {
      if (item.isResetArchive) return false;
      const rMs = parseResetTimestampMs(item.resetsAt);
      const nMs = item.naturalResetsAt ? parseResetTimestampMs(item.naturalResetsAt) : rMs;
      return (
        (!Number.isNaN(rMs) && Math.abs(rMs - existingNatResetToReplaceMs) <= CLUSTER_TOLERANCE_MS_CONST) ||
        (!Number.isNaN(nMs) && Math.abs(nMs - existingNatResetToReplaceMs) <= CLUSTER_TOLERANCE_MS_CONST)
      );
    });
  }

  let replacedBackup = null;
  if (openIdx >= 0) {
    replacedBackup = { ...list[openIdx] };
    const effectiveUsed = Math.max(Number(list[openIdx].usedPercentage || 0), Number(usedPct || 0));
    list[openIdx] = {
      ...list[openIdx],
      id: historyId,
      resetEventId: eventId,
      cycleStartAt: startIso,
      resetsAt: endIso,
      naturalResetsAt: natIso || list[openIdx].naturalResetsAt || list[openIdx].resetsAt,
      usedPercentage: Number(effectiveUsed.toFixed(2)),
      asOf: endIso,
      isResetArchive: true,
      resetMode: mode,
      resetSource,
      source: sourceLabel
    };
    list.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
    return { dirty: true, replacedBackup, historyId };
  }

  const dirty = upsertQuotaHistoryBucket(list, {
    id: historyId,
    resetEventId: eventId,
    cycleStartAt: startIso,
    resetsAt: endIso,
    naturalResetsAt: natIso,
    usedPercentage: Number(usedPct || 0),
    asOf: endIso,
    isResetArchive: true,
    resetMode: mode,
    resetSource,
    source: sourceLabel,
    forceReplaceUsedPct: true
  });
  return { dirty, replacedBackup: null, historyId: dirty ? historyId : null };
}

function extractFiveHourSnapshotsFromPayload(platform, payload) {
  const out = [];
  if (!payload) return out;
  const fallbackTs = payload.updatedAt || new Date().toISOString();
  if (platform === 'claude' && payload.fiveHour?.resetsAt) {
    const rMs = parseResetTimestampMs(payload.fiveHour.resetsAt);
    if (!Number.isNaN(rMs)) {
      out.push({
        poolKey: 'claude',
        usedPercentage: typeof payload.fiveHour.usedPercentage === 'number' ? Number(payload.fiveHour.usedPercentage) : 0,
        resetsAt: new Date(rMs).toISOString(),
        resetsAtMs: rMs,
        windowMs: FIVE_H_MS_CONST,
        asOf: payload.fiveHour.asOf || fallbackTs,
        source: payload.source || 'claude_oauth_api'
      });
    }
  } else if (platform === 'gpt' && payload.fiveHour?.resetsAt) {
    const winMs = Number(payload.fiveHour.windowSeconds || 5 * 3600) * 1000;
    const rMs = parseResetTimestampMs(payload.fiveHour.resetsAt);
    if (!Number.isNaN(rMs)) {
      out.push({
        poolKey: 'gpt',
        usedPercentage: typeof payload.fiveHour.usedPercentage === 'number' ? Number(payload.fiveHour.usedPercentage) : 0,
        resetsAt: new Date(rMs).toISOString(),
        resetsAtMs: rMs,
        windowMs: winMs,
        asOf: payload.fiveHour.asOf || fallbackTs,
        source: payload.source || 'codex_wham_api'
      });
    }
  } else if (platform === 'antigravity') {
    const gem5h = payload.pools?.gemini || payload.fiveHour;
    if (gem5h?.resetsAt) {
      const rMs = parseResetTimestampMs(gem5h.resetsAt);
      if (!Number.isNaN(rMs)) {
        out.push({
          poolKey: 'agy-gemini',
          usedPercentage: Number(gem5h.usedPercentageExact ?? gem5h.usedPercentage ?? 0),
          resetsAt: new Date(rMs).toISOString(),
          resetsAtMs: rMs,
          windowMs: FIVE_H_MS_CONST,
          asOf: fallbackTs,
          source: payload.source || 'language_server_rpc',
          description: gem5h.description || ''
        });
      }
    }
    const tp5h = payload.pools?.claude;
    if (tp5h?.resetsAt) {
      const rMs = parseResetTimestampMs(tp5h.resetsAt);
      if (!Number.isNaN(rMs)) {
        out.push({
          poolKey: 'agy-tp',
          usedPercentage: Number(tp5h.usedPercentageExact ?? tp5h.usedPercentage ?? 0),
          resetsAt: new Date(rMs).toISOString(),
          resetsAtMs: rMs,
          windowMs: FIVE_H_MS_CONST,
          asOf: fallbackTs,
          source: payload.source || 'language_server_rpc',
          description: tp5h.description || ''
        });
      }
    }
  }
  return out;
}

function processOfficialFiveHourTransition(resetState, snap) {
  if (!snap || Number.isNaN(snap.resetsAtMs)) return false;
  const poolKey = snap.poolKey;
  const poolState =
    resetState.pools[poolKey] ||
    (resetState.pools[poolKey] = {
      activeOverride: null,
      events: [],
      observed: null,
      fiveHourObserved: null,
      fiveHourEvents: [],
      lastAnchorResetsAt: null
    });
  if (!Array.isArray(poolState.fiveHourEvents)) poolState.fiveHourEvents = [];

  const prev = poolState.fiveHourObserved;
  const currAsOfMs = parseResetTimestampMs(snap.asOf) || Date.now();
  const currResetMs = snap.resetsAtMs;
  const currUsed = Number(snap.usedPercentage || 0);

  const sameSnapshot =
    prev &&
    Math.abs((prev.resetsAtMs || parseResetTimestampMs(prev.resetsAt)) - currResetMs) <= 1000 &&
    Number(prev.usedPercentage) === currUsed &&
    prev.asOf === snap.asOf;
  if (sameSnapshot) return false;

  if (prev) {
    const prevResetMs = prev.resetsAtMs || parseResetTimestampMs(prev.resetsAt);
    const prevUsed = Number(prev.usedPercentage || 0);
    const sameWindow = !Number.isNaN(prevResetMs) && Math.abs(currResetMs - prevResetMs) <= 5 * 60_000;
    const substantialDrop = (prevUsed >= 5 && currUsed <= 1) || (prevUsed - currUsed >= 15);
    const isEarlyReset = !sameWindow && !Number.isNaN(prevResetMs) && currAsOfMs < prevResetMs - 5 * 60_000;
    const idleShift = prevUsed === 0 && currUsed === 0 && currResetMs > prevResetMs;

    if (sameWindow && currAsOfMs < currResetMs && substantialDrop) {
      poolState.fiveHourEvents.push({
        id: `rst5h_auto_${poolKey}_${currAsOfMs}`,
        pool: poolKey,
        window: '5h',
        mode: 'in_cycle',
        source: 'auto',
        resetAt: new Date(currAsOfMs).toISOString(),
        naturalResetsAt: new Date(currResetMs).toISOString(),
        prevResetsAt: new Date(prevResetMs).toISOString(),
        prevUsedPct: prevUsed,
        currUsedPct: currUsed,
        note: `5H 窗口官方回血重置 (${prevUsed}% → ${currUsed}%)`,
        createdAt: new Date().toISOString()
      });
      if (poolState.fiveHourEvents.length > 30) poolState.fiveHourEvents = poolState.fiveHourEvents.slice(-30);
    } else if (isEarlyReset && !idleShift && (prevUsed > 0 || Math.abs(currResetMs - prevResetMs) > 10 * 60_000)) {
      poolState.fiveHourEvents.push({
        id: `rst5h_auto_${poolKey}_${currAsOfMs}`,
        pool: poolKey,
        window: '5h',
        mode: 'recalculate',
        source: 'auto',
        resetAt: new Date(currAsOfMs).toISOString(),
        naturalResetsAt: new Date(currResetMs).toISOString(),
        prevResetsAt: new Date(prevResetMs).toISOString(),
        prevUsedPct: prevUsed,
        currUsedPct: currUsed,
        note: `5H 窗口官方重算重置时间 (${new Date(prevResetMs).toISOString().slice(11, 16)} → ${new Date(currResetMs).toISOString().slice(11, 16)} UTC)`,
        createdAt: new Date().toISOString()
      });
      if (poolState.fiveHourEvents.length > 30) poolState.fiveHourEvents = poolState.fiveHourEvents.slice(-30);
    }
  }

  poolState.fiveHourObserved = {
    usedPercentage: currUsed,
    resetsAt: snap.resetsAt,
    resetsAtMs: currResetMs,
    asOf: snap.asOf,
    source: snap.source,
    description: snap.description || ''
  };
  return true;
}

function extractPoolSnapshotsFromPayload(platform, payload) {
  const out = [];
  if (!payload) return out;
  const fallbackTs = payload.updatedAt || new Date().toISOString();
  if (platform === 'claude' && payload.sevenDay?.resetsAt && typeof payload.sevenDay.usedPercentage === 'number') {
    const rMs = parseResetTimestampMs(payload.sevenDay.resetsAt);
    const wMs = payload.sevenDay.windowStartedAt ? Date.parse(payload.sevenDay.windowStartedAt) : NaN;
    out.push({
      poolKey: 'claude',
      usedPercentage: Number(payload.sevenDay.usedPercentage),
      resetsAt: !Number.isNaN(rMs) ? new Date(rMs).toISOString() : payload.sevenDay.resetsAt,
      resetsAtMs: rMs,
      cycleStartAt: !Number.isNaN(wMs) ? new Date(wMs).toISOString() : (!Number.isNaN(rMs) ? new Date(rMs - SEVEN_D_MS_CONST).toISOString() : null),
      windowMs: SEVEN_D_MS_CONST,
      asOf: payload.sevenDay.asOf || fallbackTs,
      source: payload.source || 'claude_oauth_api'
    });
  } else if (platform === 'gpt' && payload.sevenDay?.resetsAt && typeof payload.sevenDay.usedPercentage === 'number') {
    const winMs = Number(payload.sevenDay.windowSeconds || 7 * 24 * 3600) * 1000;
    const rMs = parseResetTimestampMs(payload.sevenDay.resetsAt);
    out.push({
      poolKey: 'gpt',
      usedPercentage: Number(payload.sevenDay.usedPercentage),
      resetsAt: !Number.isNaN(rMs) ? new Date(rMs).toISOString() : payload.sevenDay.resetsAt,
      resetsAtMs: rMs,
      cycleStartAt: !Number.isNaN(rMs) ? new Date(rMs - winMs).toISOString() : null,
      windowMs: winMs,
      asOf: payload.sevenDay.asOf || fallbackTs,
      source: payload.source || 'codex_wham_api'
    });
  } else if (platform === 'antigravity' && payload.pools) {
    const gemW = payload.pools.geminiWeekly;
    if (gemW?.resetsAt && typeof (gemW.usedPercentageExact ?? gemW.usedPercentage) === 'number') {
      const rMs = parseResetTimestampMs(gemW.resetsAt);
      out.push({
        poolKey: 'agy-gemini',
        usedPercentage: Number(gemW.usedPercentageExact ?? gemW.usedPercentage),
        resetsAt: !Number.isNaN(rMs) ? new Date(rMs).toISOString() : gemW.resetsAt,
        resetsAtMs: rMs,
        cycleStartAt: !Number.isNaN(rMs) ? new Date(rMs - SEVEN_D_MS_CONST).toISOString() : null,
        windowMs: SEVEN_D_MS_CONST,
        asOf: fallbackTs,
        source: payload.source || 'language_server_rpc'
      });
    }
    const tpW = payload.pools.claudeWeekly;
    if (tpW?.resetsAt && typeof (tpW.usedPercentageExact ?? tpW.usedPercentage) === 'number') {
      const rMs = parseResetTimestampMs(tpW.resetsAt);
      out.push({
        poolKey: 'agy-tp',
        usedPercentage: Number(tpW.usedPercentageExact ?? tpW.usedPercentage),
        resetsAt: !Number.isNaN(rMs) ? new Date(rMs).toISOString() : tpW.resetsAt,
        resetsAtMs: rMs,
        cycleStartAt: !Number.isNaN(rMs) ? new Date(rMs - SEVEN_D_MS_CONST).toISOString() : null,
        windowMs: SEVEN_D_MS_CONST,
        asOf: fallbackTs,
        source: payload.source || 'language_server_rpc'
      });
    }
  }
  return out;
}

// Detect official intra-cycle resets (same resetsAt, significant used% drop) and natural-reset recalculations
function processOfficialQuotaTransition(history, resetState, snap) {
  if (!snap || Number.isNaN(snap.resetsAtMs)) return { historyDirty: false, resetsDirty: false };
  const poolKey = snap.poolKey;
  const poolState =
    resetState.pools[poolKey] ||
    (resetState.pools[poolKey] = {
      activeOverride: null,
      events: [],
      observed: null,
      fiveHourObserved: null,
      fiveHourEvents: [],
      lastAnchorResetsAt: null
    });
  const prev = poolState.observed;
  const list = history[poolKey] || (history[poolKey] = []);

  let historyDirty = false;
  let resetsDirty = false;

  const currAsOfMs = parseResetTimestampMs(snap.asOf) || Date.now();
  const currResetMs = snap.resetsAtMs;
  const currUsed = Number(snap.usedPercentage);
  const windowMs = snap.windowMs || SEVEN_D_MS_CONST;

  // If a stale manual override exists, and we now receive a fresher official live snapshot (especially after official global reset),
  // automatically hand back control to official live tracking!
  if (poolState.activeOverride && poolState.activeOverride.source === 'manual') {
    const manualResetAtMs = Date.parse(poolState.activeOverride.resetAt || '');
    const snapResetAtResetMs = poolState.activeOverride.snapshotResetsAtAtReset
      ? Date.parse(poolState.activeOverride.snapshotResetsAtAtReset)
      : NaN;
    const officialResetChanged =
      !Number.isNaN(snapResetAtResetMs) &&
      Math.abs(currResetMs - snapResetAtResetMs) > CLUSTER_TOLERANCE_MS_CONST;
    const officialIsFresher = Number.isFinite(manualResetAtMs) && currAsOfMs > manualResetAtMs + 2_000;
    if (officialIsFresher && (officialResetChanged || currResetMs > Date.now())) {
      poolState.activeOverride = null;
      poolState.lastAnchorResetsAt = new Date(currResetMs).toISOString();
      resetsDirty = true;
    }
  }

  const sameSnapshot =
    prev &&
    Math.abs((prev.resetsAtMs || parseResetTimestampMs(prev.resetsAt)) - currResetMs) <= 1000 &&
    Number(prev.usedPercentage) === currUsed &&
    prev.asOf === snap.asOf;
  if (sameSnapshot) {
    return { historyDirty, resetsDirty };
  }

  let effectiveCycleStartIso = snap.cycleStartAt;

  if (prev) {
    const prevResetMs = prev.resetsAtMs || parseResetTimestampMs(prev.resetsAt);
    const prevUsed = Number(prev.usedPercentage || 0);
    const prevAsOfMs = parseResetTimestampMs(prev.asOf) || (currAsOfMs - 60_000);
    const sameNaturalReset = !Number.isNaN(prevResetMs) && Math.abs(currResetMs - prevResetMs) <= CLUSTER_TOLERANCE_MS_CONST;

    const activeOv = poolState.activeOverride;
    const ovStartMs = activeOv ? Date.parse(activeOv.cycleStartAt) : NaN;
    const ovNatResetMs = activeOv ? Date.parse(activeOv.naturalResetsAt) : NaN;
    const prevStageStartMs =
      activeOv && !Number.isNaN(ovStartMs) && !Number.isNaN(ovNatResetMs) && Math.abs(ovNatResetMs - prevResetMs) <= CLUSTER_TOLERANCE_MS_CONST
        ? ovStartMs
        : (prev.cycleStartAt ? Date.parse(prev.cycleStartAt) : prevResetMs - windowMs);

    const substantialDrop =
      (prevUsed >= 5 && currUsed <= 1) || (prevUsed - currUsed >= 15);

    // Case 1: Intra-cycle reset (same natural resetsAt, still before reset time, quota dropped significantly)
    if (sameNaturalReset && currAsOfMs < currResetMs && substantialDrop) {
      const eventId = `rst_auto_${poolKey}_${currAsOfMs}`;
      const resetAtMs = Math.max(prevAsOfMs, currAsOfMs);
      const resetAtIso = new Date(resetAtMs).toISOString();
      const natResetIso = new Date(currResetMs).toISOString();

      const sealed = sealCycleSegmentToHistory(list, {
        archiveStartMs: prevStageStartMs,
        archiveEndMs: resetAtMs,
        naturalResetsAtMs: currResetMs,
        usedPct: prevUsed,
        mode: 'in_cycle',
        resetSource: 'auto',
        eventId,
        sourceLabel: `${snap.source || 'official'} (周内重置前段)`,
        existingNatResetToReplaceMs: currResetMs
      });
      if (sealed.dirty) historyDirty = true;

      const ev = {
        id: eventId,
        pool: poolKey,
        window: '7d',
        mode: 'in_cycle',
        source: 'auto',
        resetAt: resetAtIso,
        cycleStartAt: resetAtIso,
        naturalResetsAt: natResetIso,
        prevCycleStartAt: new Date(prevStageStartMs).toISOString(),
        prevResetsAt: natResetIso,
        prevUsedPct: prevUsed,
        currUsedPct: currUsed,
        archivedHistoryId: sealed.historyId,
        replacedBackup: sealed.replacedBackup,
        note: `自动检测到官方周内重置 (${prevUsed}% → ${currUsed}%)，自然重置时间不变`,
        createdAt: new Date().toISOString()
      };
      poolState.events.push(ev);
      if (poolState.events.length > 50) poolState.events = poolState.events.slice(-50);

      poolState.activeOverride = {
        eventId,
        mode: 'in_cycle',
        source: 'auto',
        resetAt: resetAtIso,
        cycleStartAt: resetAtIso,
        naturalResetsAt: natResetIso,
        windowMs,
        baseOfficialUsedPct: currUsed,
        snapshotUsedPctAtReset: prevUsed,
        snapshotResetsAtAtReset: natResetIso,
        snapshotAsOfAtReset: snap.asOf,
        prevCycleStartAt: ev.prevCycleStartAt,
        prevResetsAt: natResetIso,
        prevUsedPct: prevUsed,
        note: ev.note
      };
      poolState.lastAnchorResetsAt = natResetIso;
      resetsDirty = true;
      effectiveCycleStartIso = resetAtIso;
    } else if (!sameNaturalReset && !Number.isNaN(prevResetMs)) {
      const bothZeroIdle =
        prevUsed === 0 &&
        currUsed === 0 &&
        currAsOfMs < prevResetMs &&
        currResetMs > prevResetMs &&
        (currResetMs - prevResetMs) < 6.5 * DAY_MS;

      if (!bothZeroIdle) {
        const isEarlyReset = currAsOfMs < prevResetMs - CLUSTER_TOLERANCE_MS_CONST;
        const newStartMs = snap.cycleStartAt ? Date.parse(snap.cycleStartAt) : currResetMs - windowMs;
        const diffFromPrev = currResetMs - prevResetMs;
        const nearestWeekMult = Math.round(diffFromPrev / windowMs);
        const alignedNaturalStep =
          nearestWeekMult >= 1 && Math.abs(diffFromPrev - nearestWeekMult * windowMs) <= CLUSTER_TOLERANCE_MS_CONST;

        if (isEarlyReset || !alignedNaturalStep) {
          const eventId = `rst_auto_${poolKey}_${currAsOfMs}`;
          const resetAtMs = isEarlyReset
            ? Math.max(
                prevStageStartMs + 60_000,
                Math.min(currAsOfMs, Number.isFinite(newStartMs) && newStartMs > prevStageStartMs ? newStartMs : currAsOfMs)
              )
            : Math.max(prevResetMs, Number.isFinite(newStartMs) ? newStartMs : currAsOfMs);
          const resetAtIso = new Date(resetAtMs).toISOString();
          const newNatIso = new Date(currResetMs).toISOString();
          const prevNatIso = new Date(prevResetMs).toISOString();

          if (isEarlyReset && (prevUsed > 0 || resetAtMs > prevStageStartMs + 60_000)) {
            const sealed = sealCycleSegmentToHistory(list, {
              archiveStartMs: prevStageStartMs,
              archiveEndMs: resetAtMs,
              naturalResetsAtMs: prevResetMs,
              usedPct: prevUsed,
              mode: 'recalculate',
              resetSource: 'auto',
              eventId,
              sourceLabel: `${snap.source || 'official'} (官方重置重算前段)`,
              existingNatResetToReplaceMs: prevResetMs
            });
            if (sealed.dirty) historyDirty = true;
          }

          if (isEarlyReset || substantialDrop || !alignedNaturalStep) {
            const ev = {
              id: eventId,
              pool: poolKey,
              window: '7d',
              mode: 'recalculate',
              source: 'auto',
              resetAt: resetAtIso,
              cycleStartAt: Number.isFinite(newStartMs) ? new Date(newStartMs).toISOString() : resetAtIso,
              naturalResetsAt: newNatIso,
              prevCycleStartAt: new Date(prevStageStartMs).toISOString(),
              prevResetsAt: prevNatIso,
              prevUsedPct: prevUsed,
              currUsedPct: currUsed,
              note: isEarlyReset
                ? `自动检测到官方重算重置时间 (${prevNatIso.slice(5, 16)} → ${newNatIso.slice(5, 16)} UTC)`
                : `自动检测到新周期重新锚定 (${newNatIso.slice(5, 16)} UTC)`,
              createdAt: new Date().toISOString()
            };
            poolState.events.push(ev);
            if (poolState.events.length > 50) poolState.events = poolState.events.slice(-50);

            poolState.activeOverride = null;
            poolState.lastAnchorResetsAt = newNatIso;
            resetsDirty = true;
          }
        } else if (poolState.activeOverride && currAsOfMs >= parseResetTimestampMs(poolState.activeOverride.naturalResetsAt)) {
          poolState.activeOverride = null;
          poolState.lastAnchorResetsAt = new Date(currResetMs).toISOString();
          resetsDirty = true;
        }
      }
    }
  }

  if (
    poolState.activeOverride &&
    poolState.activeOverride.mode === 'in_cycle' &&
    Math.abs(Date.parse(poolState.activeOverride.naturalResetsAt) - currResetMs) <= CLUSTER_TOLERANCE_MS_CONST
  ) {
    effectiveCycleStartIso = poolState.activeOverride.cycleStartAt;
  }

  const upserted = upsertQuotaHistoryBucket(list, {
    cycleStartAt: effectiveCycleStartIso,
    resetsAt: snap.resetsAt,
    naturalResetsAt: snap.resetsAt,
    usedPercentage: currUsed,
    asOf: snap.asOf,
    source: snap.source
  });
  if (upserted) historyDirty = true;

  poolState.observed = {
    usedPercentage: currUsed,
    resetsAt: snap.resetsAt,
    resetsAtMs: currResetMs,
    cycleStartAt: effectiveCycleStartIso,
    asOf: snap.asOf,
    source: snap.source
  };
  resetsDirty = true;

  return { historyDirty, resetsDirty };
}

function archivePlatformQuotaToHistory(history, platform, payload, resetState = null) {
  if (!payload) return { historyDirty: false, resetsDirty: false };
  const snaps = extractPoolSnapshotsFromPayload(platform, payload);
  const fhSnaps = extractFiveHourSnapshotsFromPayload(platform, payload);
  let historyDirty = false;
  let resetsDirty = false;
  const rs = resetState || loadQuotaResets();
  for (const s of snaps) {
    const res = processOfficialQuotaTransition(history, rs, s);
    if (res.historyDirty) historyDirty = true;
    if (res.resetsDirty) resetsDirty = true;
  }
  for (const s5 of fhSnaps) {
    if (processOfficialFiveHourTransition(rs, s5)) {
      resetsDirty = true;
    }
  }
  if (resetsDirty && !resetState) {
    saveQuotaResets(rs);
  }
  return { historyDirty, resetsDirty };
}

function archiveLiveQuotaSnapshot(liveQuota, resetState = null) {
  if (!liveQuota) return loadQuotaHistory();
  const history = loadQuotaHistory();
  const rs = resetState || loadQuotaResets();
  let historyDirty = false;
  let resetsDirty = false;
  for (const platform of ['claude', 'gpt', 'antigravity']) {
    const res = archivePlatformQuotaToHistory(history, platform, liveQuota[platform], rs);
    if (res.historyDirty) historyDirty = true;
    if (res.resetsDirty) resetsDirty = true;
  }
  if (historyDirty) saveQuotaHistory(history);
  if (resetsDirty && !resetState) saveQuotaResets(rs);
  return history;
}

export function saveLiveQuota(platform, payload) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const current = loadLiveQuota();
  const prevEntry = current[platform];
  current[platform] = {
    ...current[platform],
    ...payload,
    updatedAt: new Date().toISOString()
  };
  try {
    const tmp = `${LIVE_QUOTA_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(tmp, LIVE_QUOTA_FILE);
  } catch {
    fs.writeFileSync(LIVE_QUOTA_FILE, JSON.stringify(current, null, 2), 'utf8');
  }
  try {
    const history = loadQuotaHistory();
    const rs = loadQuotaResets();
    let historyDirty = false;
    let resetsDirty = false;
    if (prevEntry) {
      const r1 = archivePlatformQuotaToHistory(history, platform, prevEntry, rs);
      if (r1.historyDirty) historyDirty = true;
      if (r1.resetsDirty) resetsDirty = true;
    }
    const r2 = archivePlatformQuotaToHistory(history, platform, current[platform], rs);
    if (r2.historyDirty) historyDirty = true;
    if (r2.resetsDirty) resetsDirty = true;
    if (historyDirty) saveQuotaHistory(history);
    if (resetsDirty) saveQuotaResets(rs);
  } catch {}
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
    cached.pricingVersion === ENGINE_VERSION &&
    cached.claudeParserVersion === CLAUDE_PARSER_VERSION
  ) {
    return cached.data;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  // Deduplicate turns by message.id (Claude Code writes multiple streaming lines per API turn)
  const turnMap = new Map();
  const uuidMap = new Map();
  let lastPreRequestTsMs = null;
  let sessionId = '';
  let cwd = '';
  let firstUserPrompt = '';
  let firstTimestamp = null;
  let lastTimestamp = null;
  let promptSeq = 0;

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

      if (obj.type === 'user' && !obj.isMeta && !obj.isCompactSummary && obj.message?.content) {
        const c = obj.message.content;
        const isOnlyToolResult = Array.isArray(c) && c.length > 0 && c.every(b => b && b.type === 'tool_result');
        if (!isOnlyToolResult) {
          promptSeq += 1;
        }
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

        const prevTokTotal = prev
          ? prev.inputTokens + prev.cacheCreationTokens + prev.cacheReadTokens + prev.outputTokens
          : -1;
        const curTokTotal = inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens;
        const keepPrevUsage = curTokTotal < prevTokTotal;

        // Always keep the entry with highest cumulative usage for the same message.id
        turnMap.set(msgId, {
          id: msgId,
          platform: 'claude',
          surface:
            cwd.includes('AppData\\Roaming\\Claude') || cwd.includes('AppData/Roaming/Claude')
              ? 'Claude Desktop'
              : 'Claude Code CLI',
          sessionId: sessionId || path.basename(filePath, '.jsonl'),
          promptSeq: prev?.promptSeq || promptSeq || 1,
          timestamp: obj.timestamp || lastTimestamp || new Date(stat.mtimeMs).toISOString(),
          model: msg.model || prev?.model,
          inputTokens: keepPrevUsage ? prev.inputTokens : inputTokens,
          cacheCreationTokens: keepPrevUsage ? prev.cacheCreationTokens : cacheCreationTokens,
          cacheReadTokens: keepPrevUsage ? prev.cacheReadTokens : cacheReadTokens,
          outputTokens: keepPrevUsage ? prev.outputTokens : outputTokens,
          thinkingTokens: keepPrevUsage ? prev.thinkingTokens : thinkingTokens,
          toolCallsCount: toolIds.size,
          toolIds,
          reqStartMs,
          endTsMs,
          thinkingDurationMs
        });
      }
    } catch {}
  }

  if (!sessionId) sessionId = path.basename(filePath, '.jsonl');
  for (const t of turnMap.values()) {
    t.sessionId = sessionId;
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

  setFileCacheEntry(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pricingVersion: ENGINE_VERSION,
    claudeParserVersion: CLAUDE_PARSER_VERSION,
    data
  });
  return data;
}

function scanAllClaudeSessions({ force = false } = {}) {
  ensureDiskCacheLoaded();
  const now = Date.now();
  if (!force && scanStateCache.claude.sessions && now - scanStateCache.claude.scannedAt < 2500) {
    return scanStateCache.claude.sessions;
  }
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

  // Parse all non-empty Claude JSONL files first (skip repeated stat for cold files >12h old within 45s)
  const parsedFiles = [];
  const fileMeta = scanStateCache.claude.fileMeta;
  for (const file of jsonlFiles) {
    try {
      const memo = fileMeta.get(file);
      let stat;
      if (
        !force &&
        memo &&
        now - memo.mtimeMs > 12 * 3600 * 1000 &&
        now - memo.checkedAt < 45_000 &&
        fileCache.has(file)
      ) {
        stat = { mtimeMs: memo.mtimeMs, size: memo.size };
      } else {
        stat = fs.statSync(file);
        fileMeta.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
      }
      const parsed = parseClaudeJsonlFile(file, stat);
      if (parsed.turns.length > 0) parsedFiles.push(parsed);
    } catch {}
  }

  // Merge files sharing the same sessionId (e.g., mirrored AppData paths or subagent logs)
  const sessionsById = new Map();
  const bestTurnById = new Map();
  const turnTotalTok = t =>
    (t.inputTokens || 0) + (t.cacheCreationTokens || 0) + (t.cacheReadTokens || 0) + (t.outputTokens || 0);

  for (const parsed of parsedFiles) {
    for (const t of parsed.turns) {
      const prev = bestTurnById.get(t.id);
      if (!prev || turnTotalTok(t) > turnTotalTok(prev)) {
        bestTurnById.set(t.id, t);
      }
    }
    const existing = sessionsById.get(parsed.sessionId);
    if (!existing) {
      sessionsById.set(parsed.sessionId, {
        ...parsed,
        turns: [...parsed.turns]
      });
    } else {
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
  }

  // Globally deduplicate forked/worktree sessions sharing the same message.id across files
  const mergedSessions = Array.from(sessionsById.values()).sort((a, b) => {
    const tsCmp = String(a.firstTimestamp || '').localeCompare(String(b.firstTimestamp || ''));
    if (tsCmp !== 0) return tsCmp;
    return b.turns.length - a.turns.length;
  });

  const claimedTurnIds = new Set();
  const finalSessions = [];
  for (const sess of mergedSessions) {
    const uniqueTurns = [];
    for (const rawTurn of sess.turns) {
      if (claimedTurnIds.has(rawTurn.id)) continue;
      claimedTurnIds.add(rawTurn.id);
      const best = bestTurnById.get(rawTurn.id) || rawTurn;
      uniqueTurns.push(best.sessionId === sess.sessionId ? best : { ...best, sessionId: sess.sessionId });
    }
    if (uniqueTurns.length === 0) continue;
    finalSessions.push({ ...sess, turns: uniqueTurns });
  }

  scanStateCache.claude.sessions = finalSessions;
  scanStateCache.claude.scannedAt = Date.now();
  return finalSessions;
}

// 2. Scan Google Antigravity sessions across antigravity, antigravity-cli, antigravity-ide
function loadAntigravitySummaries(surfaceDir) {
  const dbPath = path.join(surfaceDir, 'conversation_summaries.db');
  const sig = dbSignature(dbPath);
  if (!sig || sig === '-|-') return new Map();
  const cached = scanStateCache.antigravity.summaries.get(surfaceDir);
  if (cached && cached.sig === sig) return cached.map;

  const summaryMap = new Map();
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
        agentName: r.agent_name || '',
        lastModifiedTime: r.last_modified_time || 0
      });
    }
    db.close();
    scanStateCache.antigravity.summaries.set(surfaceDir, { sig, map: summaryMap });
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
        let modelEnum = '';
        let cascadeId = '';
        let lastStepIndex = null;
        for (const x of f) {
          if (x.fn === 20 && x.b) {
            try {
              const kv = pbReadFields(x.b);
              const k = kv.find(y => y.fn === 1 && y.b)?.b.toString('utf8');
              const v = kv.find(y => y.fn === 2 && y.b)?.b.toString('utf8');
              if (k === 'model_enum' && v) modelEnum = v;
              else if (k === 'cascade_id' && v) cascadeId = v;
              else if (k === 'last_step_index' && v !== undefined) {
                const n = Number(v);
                if (Number.isFinite(n)) lastStepIndex = n;
              }
            } catch {}
          }
        }
        const respBytes = u.find(x => x.fn === 11 && x.b)?.b;
        rows.push({
          inputTokens: Number(u.find(x => x.fn === 2)?.v ?? -1n),
          outputTokens: Number(u.find(x => x.fn === 3)?.v ?? -1n),
          cacheReadTokens: Number(u.find(x => x.fn === 5)?.v ?? 0n),
          lastStepIndex,
          modelId: str(19),
          label: str(21),
          modelEnum,
          cascadeId,
          responseId: respBytes ? respBytes.toString('utf8') : ''
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

function dbSignature(dbPath, existingFileNames = null) {
  try {
    const baseName = existingFileNames ? path.basename(dbPath) : null;
    const p1 =
      !existingFileNames || existingFileNames.has(baseName)
        ? (() => {
            try {
              const st = fs.statSync(dbPath);
              return `${st.mtimeMs}:${st.size}`;
            } catch {
              return '-';
            }
          })()
        : '-';
    const walPath = `${dbPath}-wal`;
    const p2 =
      !existingFileNames || existingFileNames.has(`${baseName}-wal`)
        ? (() => {
            try {
              const st = fs.statSync(walPath);
              return `${st.mtimeMs}:${st.size}`;
            } catch {
              return '-';
            }
          })()
        : '-';
    return `${p1}|${p2}`;
  } catch {
    return '';
  }
}

async function dbSignatureAsync(dbPath, existingFileNames = null) {
  try {
    const baseName = existingFileNames ? path.basename(dbPath) : null;
    const [p1, p2] = await Promise.all([
      !existingFileNames || existingFileNames.has(baseName)
        ? fsp.stat(dbPath).then(st => `${st.mtimeMs}:${st.size}`).catch(() => '-')
        : Promise.resolve('-'),
      !existingFileNames || existingFileNames.has(`${baseName}-wal`)
        ? fsp.stat(`${dbPath}-wal`).then(st => `${st.mtimeMs}:${st.size}`).catch(() => '-')
        : Promise.resolve('-')
    ]);
    return `${p1}|${p2}`;
  } catch {
    return '';
  }
}

const GEN_MODEL_ENUM_MAP = {
  MODEL_PLACEHOLDER_M669: 'gemini-orchestrator-executor', // Orchestrator offloaded Hydrogen executor
  MODEL_PLACEHOLDER_M667: 'gemini-pro-orchestrator',      // Orchestrator (Carbon) planner
  MODEL_PLACEHOLDER_M681: 'gemini-pro-orchestrator-argon',// Orchestrator (Argon) planner
  MODEL_PLACEHOLDER_M537: 'gemini-pro-orchestrator-neon', // Orchestrator (Neon) planner
  MODEL_PLACEHOLDER_M532: 'gemini-4-neon-high',
  MODEL_PLACEHOLDER_M533: 'gemini-4-neon-medium',
  MODEL_PLACEHOLDER_M534: 'gemini-4-neon-low',
  MODEL_PLACEHOLDER_M535: 'gemini-4-neon-xhigh',
  MODEL_PLACEHOLDER_M525: 'gemini-4-hydrogen-high',
  MODEL_PLACEHOLDER_M526: 'gemini-4-hydrogen-medium',
  MODEL_PLACEHOLDER_M527: 'gemini-4-hydrogen-low',
  MODEL_PLACEHOLDER_M528: 'gemini-4-hydrogen-xhigh',
  MODEL_PLACEHOLDER_M346: 'gemini-4-hydrogen-high',       // Vertex AI / Gateway Hydrogen High
  MODEL_PLACEHOLDER_M340: 'gemini-4-hydrogen',            // Vertex AI / Gateway Hydrogen
  MODEL_PLACEHOLDER_M461: 'gemini-4-hydrogen-high',       // Vertex AI / Gateway Hydrogen (High)
  MODEL_PLACEHOLDER_M427: 'gemini-4-carbon-high',
  MODEL_PLACEHOLDER_M437: 'gemini-4-carbon-medium',
  MODEL_PLACEHOLDER_M438: 'gemini-4-carbon-low',
  MODEL_PLACEHOLDER_M417: 'gemini-4-argon-high',
  MODEL_PLACEHOLDER_M418: 'gemini-4-argon-medium',
  MODEL_PLACEHOLDER_M419: 'gemini-4-argon-low',
  MODEL_PLACEHOLDER_M318: 'gemini-flash-high',
  MODEL_PLACEHOLDER_M319: 'gemini-flash-medium',
  MODEL_PLACEHOLDER_M320: 'gemini-flash-low',
  MODEL_PLACEHOLDER_M322: 'gemini-flash',
  MODEL_PLACEHOLDER_M400: 'claude-opus-5-5-low',
  MODEL_PLACEHOLDER_M401: 'claude-opus-5-5-medium',
  MODEL_PLACEHOLDER_M402: 'claude-opus-5-5-high',
  MODEL_PLACEHOLDER_M403: 'claude-sonnet-5-5-low',
  MODEL_PLACEHOLDER_M404: 'claude-sonnet-5-5-medium',
  MODEL_PLACEHOLDER_M405: 'claude-sonnet-5-5-high'
};

// Enum IDs exclusively observed on external Vertex AI / gateway configs (never in Antigravity consumer configs)
const EXTERNAL_API_MODEL_ENUMS = new Set([
  'MODEL_PLACEHOLDER_M340',
  'MODEL_PLACEHOLDER_M346',
  'MODEL_PLACEHOLDER_M461'
]);

/**
 * Parse ~/.gemini/<surface>/log/cli*.log to map ResponseID -> authMethod / request URL.
 * Distinguishes Antigravity consumer subscription calls (cloudcode-pa + authMethod=consumer)
 * from Vertex AI / local gateway / ADC calls.
 */
function loadAntigravityLogIndex(surfaceRoot) {
  const responseMap = new Map();
  const logDir = path.join(surfaceRoot, 'log');
  if (!fs.existsSync(logDir)) return responseMap;

  let logFiles = [];
  try {
    logFiles = fs
      .readdirSync(logDir, { withFileTypes: true })
      .filter(d => d.isFile() && /^cli(?:-[A-Za-z0-9_.-]+)?\.log$/i.test(d.name))
      .map(d => path.join(logDir, d.name))
      .sort();
  } catch {
    return responseMap;
  }

  for (const logPath of logFiles) {
    try {
      const st = fs.statSync(logPath);
      const cached = logFileCache.get(logPath);
      let entries;
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        entries = cached.entries;
      } else {
        entries = [];
        const content = fs.readFileSync(logPath, 'utf8');
        let currentAuthMethod = '';
        for (const line of content.split(/\r?\n/)) {
          const authMatch = line.match(/applyAuthResult:.*?\bauthMethod=([A-Za-z0-9_-]+)/);
          if (authMatch) {
            currentAuthMethod = authMatch[1].toLowerCase();
            continue;
          }
          const reqMatch = line.match(/URL:\s*(https?:\/\/\S+).*?\bResponseID:\s*([A-Za-z0-9_-]+)/);
          if (!reqMatch) continue;
          const url = reqMatch[1];
          const responseId = reqMatch[2];
          const isConsumerUrl = url.includes('cloudcode-pa.googleapis.com');
          const isConsumerAuth = !currentAuthMethod || currentAuthMethod === 'consumer';
          const isExternalApi = !isConsumerUrl || !isConsumerAuth;
          let billingSource = 'subscription';
          if (isExternalApi) {
            if (currentAuthMethod === 'gateway' || /127\.0\.0\.1|localhost/i.test(url)) {
              billingSource = 'vertex-gateway';
            } else if (currentAuthMethod === 'adc' || /aiplatform\.googleapis\.com/i.test(url)) {
              billingSource = 'vertex-ai';
            } else {
              billingSource = 'external-api';
            }
          }
          entries.push({
            responseId,
            info: { isExternalApi, billingSource, endpoint: url, authMethod: currentAuthMethod }
          });
        }
        setLogCacheEntry(logPath, { mtimeMs: st.mtimeMs, size: st.size, entries });
      }
      for (const item of entries) {
        responseMap.set(item.responseId, item.info);
      }
    } catch {}
  }
  return responseMap;
}

function classifyAntigravityTurnSource({ responseId, modelEnum, rawLabel, logIndex }) {
  if (responseId && logIndex?.has(responseId)) {
    return logIndex.get(responseId);
  }
  if (modelEnum && EXTERNAL_API_MODEL_ENUMS.has(modelEnum)) {
    return { isExternalApi: true, billingSource: 'vertex-ai' };
  }
  const trimmed = String(rawLabel || '').trim();
  if (/^(?:projects\/|gemini-4-hydrogen(?:-(?:low|medium|high|xhigh))?$)/.test(trimmed)) {
    return { isExternalApi: true, billingSource: 'vertex-ai' };
  }
  return { isExternalApi: false, billingSource: 'subscription' };
}

/** Align transcript turns to gen_metadata rows (same order) and stamp the real model on each turn. */
function applyGenModels(turns, rows, convId = '', logIndex = null) {
  if (!rows || rows.length === 0 || turns.length === 0) return 0;
  const filteredRows =
    convId && rows.some(r => r && r.cascadeId === convId)
      ? rows.filter(r => !r || !r.cascadeId || r.cascadeId === convId)
      : rows;
  const sameCount = filteredRows.length === turns.length;
  let j = 0;
  let matched = 0;
  turns.forEach((t, i) => {
    let hit = -1;
    for (let k = j; k < Math.min(filteredRows.length, j + 64); k++) {
      const r = filteredRows[k];
      if (r && r.inputTokens === t.inputTokens && r.outputTokens === t.outputTokens) {
        hit = k;
        break;
      }
    }
    if (hit < 0 && sameCount && filteredRows[i]) hit = i;
    if (hit < 0) return;
    j = hit + 1;
    const row = filteredRows[hit];
    t.responseId = row.responseId || '';
    t.modelEnum = row.modelEnum || '';
    t.rawModelLabel = row.label || row.modelId || '';
    const srcInfo = classifyAntigravityTurnSource({
      responseId: t.responseId,
      modelEnum: t.modelEnum,
      rawLabel: t.rawModelLabel,
      logIndex
    });
    t.isExternalApi = Boolean(srcInfo.isExternalApi);
    t.billingSource = srcInfo.billingSource || (t.isExternalApi ? 'vertex-ai' : 'subscription');

    const mappedByEnum = row.modelEnum ? GEN_MODEL_ENUM_MAP[row.modelEnum] : '';
    const name =
      mappedByEnum ||
      (row.modelId === 'gemini-flash-worker-agy' ? 'gemini-orchestrator-executor' : '') ||
      row.label ||
      row.modelId;
    if (!name) return;
    t.model = name;
    t.modelSource = 'gen_metadata';
    matched++;
  });
  return matched;
}

function parseAntigravityTranscript(filePath, stat, convId, surfaceLabel, meta = {}) {
  const cacheKey = filePath;
  const cached = fileCache.get(cacheKey);
  const dbSig =
    meta.dbSig !== undefined
      ? meta.dbSig
      : meta.dbPath
      ? dbSignature(meta.dbPath, meta.convFileNames || null)
      : '';
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.pricingVersion === ENGINE_VERSION &&
    cached.agyParserVersion === AGY_PARSER_VERSION &&
    cached.dbSig === dbSig &&
    cached.data?.spawnedSubagents !== undefined &&
    !cached.data?.turns?.some(t => String(t.model).startsWith('(['))
  ) {
    const out = cached.data;
    if (meta.title && meta.title !== out.title) {
      out.title = meta.title;
    }
    if (meta.workspacePath && meta.workspacePath !== out.projectPath) {
      out.projectPath = meta.workspacePath;
      out.projectLabel = formatWorkspaceLabel(meta.workspacePath);
    }
    return out;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  let activeModel = meta.agentName === 'research' ? 'Gemini 3.8 Flash' : 'Gemini 4 Argon (High)';
  let activeModelIsExternalSlug = false;
  let hasExplicitModel = false;
  let swarmMemberName = '';
  let detectedParentId = meta.parentConversationId || '';
  const spawnedSubagents = {};
  let firstUserPrompt = '';
  let firstTimestamp = null;
  let lastTimestamp = null;
  let promptSeq = 0;
  let workspaceFromLogs = meta.workspacePath || '';
  const turns = [];
  const legacyPlannerSteps = [];
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
        promptSeq += 1;
        const modelMatch = obj.content.match(
          /<USER_SETTINGS_CHANGE>[\s\S]*?Model Selection` from .*? to ([^\r\n<]+?)(?:\.\s+No need|\.\s*$|\r?\n|<)/i
        );
        if (modelMatch) {
          activeModel = modelMatch[1].trim();
          activeModelIsExternalSlug = /^(?:projects\/|gemini-4-hydrogen(?:-(?:low|medium|high|xhigh))?$)/.test(activeModel);
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
        const hasInlineTokens = inputTokens + cacheReadTokens + outputTokens > 0;
        if (!hasInlineTokens && !(meta.dbPath && fs.existsSync(meta.dbPath))) continue;

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

        let rawDurMs = 0;
        let durationMs = null;
        let tps = null;
        const nextStep = parsedSteps[idx + 1]?.obj;
        if (nextStep && nextStep.type === 'GENERIC') {
          const startMs = obj.created_at ? Date.parse(obj.created_at) : NaN;
          const endMs = nextStep.created_at ? Date.parse(nextStep.created_at) : NaN;
          rawDurMs = !Number.isNaN(startMs) && !Number.isNaN(endMs) ? endMs - startMs : 0;
          if (rawDurMs <= 0 && idx > 0) {
            const prevStep = parsedSteps[idx - 1]?.obj;
            const prevMs = prevStep?.created_at ? Date.parse(prevStep.created_at) : NaN;
            if (!Number.isNaN(prevMs) && !Number.isNaN(endMs) && endMs > prevMs && endMs - prevMs <= 60_000) {
              rawDurMs = endMs - prevMs;
            }
          }
          if (outputTokens > 0 && rawDurMs >= 1000 && rawDurMs <= 180_000) {
            const rawTps = outputTokens / (rawDurMs / 1000);
            if (rawTps > 0 && rawTps <= 400) {
              durationMs = Math.round(rawDurMs);
              tps = Number(rawTps.toFixed(1));
            }
          }
        }

        if (!hasInlineTokens) {
          legacyPlannerSteps.push({
            stepIndex: obj.step_index ?? i,
            promptSeq: promptSeq || 1,
            timestamp: obj.created_at || lastTimestamp || new Date(stat.mtimeMs).toISOString(),
            fallbackModel: activeModel,
            fallbackIsExternal: activeModelIsExternalSlug,
            rawDurMs,
            toolCallsCount: Array.isArray(obj.tool_calls) ? obj.tool_calls.length : 0
          });
          continue;
        }

        const turnBase = {
          id: `${convId}_step_${obj.step_index ?? i}`,
          platform: 'antigravity',
          surface: surfaceLabel,
          sessionId: convId,
          promptSeq: promptSeq || 1,
          timestamp: obj.created_at || lastTimestamp || new Date(stat.mtimeMs).toISOString(),
          model: activeModel,
          isExternalApi: activeModelIsExternalSlug,
          billingSource: activeModelIsExternalSlug ? 'vertex-ai' : 'subscription',
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

  // Prefer the model that actually served each call (gen_metadata) over inferred models,
  // and recover legacy Antigravity sessions whose transcript.jsonl lacked inline token fields.
  let genMatched = 0;
  if (meta.dbPath && fs.existsSync(meta.dbPath)) {
    const genRows = loadGenModelRows(meta.dbPath);
    if (turns.length === 0 && legacyPlannerSteps.length > 0 && Array.isArray(genRows) && genRows.length > 0) {
      const filteredRows =
        convId && genRows.some(r => r && r.cascadeId === convId)
          ? genRows.filter(r => !r || !r.cascadeId || r.cascadeId === convId)
          : genRows;
      const sameCount = filteredRows.length === legacyPlannerSteps.length;
      let cursor = 0;
      for (let li = 0; li < legacyPlannerSteps.length; li++) {
        const step = legacyPlannerSteps[li];
        let hit = -1;
        for (let k = cursor; k < filteredRows.length; k++) {
          const r = filteredRows[k];
          if (r && r.lastStepIndex !== null && r.lastStepIndex + 1 === step.stepIndex) {
            hit = k;
            break;
          }
        }
        if (hit < 0 && sameCount && filteredRows[li]) hit = li;
        if (hit < 0) continue;
        cursor = hit + 1;
        const row = filteredRows[hit];
        const inT = Math.max(0, Number(row.inputTokens || 0));
        const crT = Math.max(0, Number(row.cacheReadTokens || 0));
        const outT = Math.max(0, Number(row.outputTokens || 0));
        if (inT + crT + outT <= 0) continue;

        let durationMs = null;
        let tps = null;
        if (outT > 0 && step.rawDurMs >= 1000 && step.rawDurMs <= 180_000) {
          const rawTps = outT / (step.rawDurMs / 1000);
          if (rawTps > 0 && rawTps <= 400) {
            durationMs = Math.round(step.rawDurMs);
            tps = Number(rawTps.toFixed(1));
          }
        }

        const mappedByEnum = row.modelEnum ? GEN_MODEL_ENUM_MAP[row.modelEnum] : '';
        const modelName =
          mappedByEnum ||
          (row.modelId === 'gemini-flash-worker-agy' ? 'gemini-orchestrator-executor' : '') ||
          row.label ||
          row.modelId ||
          step.fallbackModel;
        const rawLabel = row.label || row.modelId || '';
        const srcInfo = classifyAntigravityTurnSource({
          responseId: row.responseId || '',
          modelEnum: row.modelEnum || '',
          rawLabel,
          logIndex: meta.logIndex || null
        });
        const turnBase = {
          id: `${convId}_step_${step.stepIndex}`,
          platform: 'antigravity',
          surface: surfaceLabel,
          sessionId: convId,
          promptSeq: step.promptSeq || 1,
          timestamp: step.timestamp,
          model: modelName,
          modelSource: 'gen_metadata',
          responseId: row.responseId || '',
          modelEnum: row.modelEnum || '',
          rawModelLabel: rawLabel,
          isExternalApi: Boolean(srcInfo.isExternalApi || step.fallbackIsExternal),
          billingSource: srcInfo.billingSource || (step.fallbackIsExternal ? 'vertex-ai' : 'subscription'),
          inputTokens: inT,
          cacheCreationTokens: 0,
          cacheReadTokens: crT,
          outputTokens: outT,
          thinkingTokens: 0,
          thinkingDurationMs: null,
          durationMs,
          tps,
          thinkingTps: null,
          toolCallsCount: step.toolCallsCount
        };
        turns.push({ ...turnBase, ...calculateTurnCost(turnBase) });
        genMatched++;
      }
    } else if (turns.length > 0 && Array.isArray(genRows) && genRows.length > 0) {
      genMatched = applyGenModels(turns, genRows, convId, meta.logIndex || null);
      if (genMatched > 0) {
        for (let ti = 0; ti < turns.length; ti++) {
          if (turns[ti].modelSource === 'gen_metadata') {
            turns[ti] = { ...turns[ti], ...calculateTurnCost(turns[ti]) };
          }
        }
      }
    }
    if (genMatched > 0) {
      // If all gen_metadata-matched turns in this session are external API, mark remaining unannotated turns likewise
      const genTurns = turns.filter(t => t.modelSource === 'gen_metadata');
      if (genTurns.length > 0 && genTurns.every(t => t.isExternalApi)) {
        const dominantSource = genTurns[0].billingSource || 'vertex-ai';
        for (const t of turns) {
          if (t.modelSource !== 'gen_metadata' && !t.isExternalApi) {
            t.isExternalApi = true;
            t.billingSource = dominantSource;
          }
        }
      }
    }
  }

  const externalCount = turns.filter(t => t.isExternalApi).length;
  const sessionIsExternal = turns.length > 0 && externalCount === turns.length;
  const dominantExternalSource = turns.find(t => t.isExternalApi)?.billingSource || 'subscription';

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
    isExternalApi: sessionIsExternal,
    hasExternalApi: externalCount > 0,
    billingSource: sessionIsExternal ? dominantExternalSource : externalCount > 0 ? 'mixed' : 'subscription',
    swarmMemberName: swarmMemberName || null,
    spawnedSubagents,
    firstTimestamp: firstTimestamp || new Date(stat.mtimeMs).toISOString(),
    lastTimestamp: lastTimestamp || new Date(stat.mtimeMs).toISOString(),
    turns
  };

  setFileCacheEntry(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pricingVersion: ENGINE_VERSION,
    agyParserVersion: AGY_PARSER_VERSION,
    dbSig,
    data
  });
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

function refreshSessionExternalBilling(session, logIndex) {
  if (!session?.turns?.length) return session;
  let changed = false;
  const refreshedTurns = session.turns.map(t => {
    const srcInfo = classifyAntigravityTurnSource({
      responseId: t.responseId,
      modelEnum: t.modelEnum,
      rawLabel: t.rawModelLabel,
      logIndex
    });
    const nextExt = t.responseId && logIndex?.has(t.responseId)
      ? Boolean(srcInfo.isExternalApi)
      : Boolean(t.isExternalApi || srcInfo.isExternalApi);
    const nextSrc = t.responseId && logIndex?.has(t.responseId)
      ? srcInfo.billingSource
      : t.billingSource || srcInfo.billingSource;
    if (Boolean(t.isExternalApi) !== nextExt || (t.billingSource || 'subscription') !== nextSrc) {
      changed = true;
      return { ...t, isExternalApi: nextExt, billingSource: nextSrc };
    }
    return t;
  });

  const turns = changed ? refreshedTurns : session.turns;
  const externalCount = turns.filter(t => t.isExternalApi).length;
  const sessionIsExternal = turns.length > 0 && externalCount === turns.length;
  const dominantExternalSource = turns.find(t => t.isExternalApi)?.billingSource || 'subscription';
  const nextBillingSource = sessionIsExternal ? dominantExternalSource : externalCount > 0 ? 'mixed' : 'subscription';
  if (!changed && Boolean(session.isExternalApi) === sessionIsExternal && session.billingSource === nextBillingSource) {
    return session;
  }
  return {
    ...session,
    isExternalApi: sessionIsExternal,
    hasExternalApi: externalCount > 0,
    billingSource: nextBillingSource,
    turns
  };
}

function finalizeAntigravitySessions(sessions, swarmModelMap) {
  // Post-pass: resolve subagent models & external-API provenance from parent sessions
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
      const entry = subagentModelMap.get(sess.sessionId);
      const swarmEntry = swarmModelMap.get(sess.sessionId);
      const parentSess = sessionById.get(entry?.parentId || sess.parentConversationId);

      // Propagate external-API status to subagent turns without their own gen_metadata/log record
      if (parentSess?.isExternalApi && sess.turns.some(t => t.modelSource !== 'gen_metadata' && !t.isExternalApi)) {
        const parentBilling = parentSess.billingSource || 'vertex-ai';
        sess.turns = sess.turns.map(t =>
          t.modelSource === 'gen_metadata' || t.isExternalApi
            ? t
            : { ...t, isExternalApi: true, billingSource: parentBilling }
        );
        sess.isExternalApi = sess.turns.every(t => t.isExternalApi);
        sess.hasExternalApi = sess.turns.some(t => t.isExternalApi);
        sess.billingSource = sess.isExternalApi ? parentBilling : 'mixed';
      }

      if (sess.hasExplicitModel) continue;
      let resolvedModel = null;
      if (swarmEntry) {
        resolvedModel = swarmEntry.model;
        if (!sess.swarmMemberName) sess.swarmMemberName = swarmEntry.name;
      } else if (entry) {
        if (entry.model.startsWith('__INHERIT__:')) {
          resolvedModel =
            parentSess?.turns?.[0]?.model || entry.model.slice('__INHERIT__:'.length);
        } else {
          resolvedModel = entry.model;
        }
      } else if (sess.isSubagent && sess.parentConversationId) {
        if (parentSess?.turns?.length > 0) {
          resolvedModel = parentSess.turns[0].model;
        }
      }
      if (
        resolvedModel &&
        sess.turns.some(t => t.modelSource !== 'gen_metadata' && t.model !== resolvedModel)
      ) {
        sess.turns = sess.turns.map(t => {
          if (t.modelSource === 'gen_metadata') return t;
          const updatedBase = { ...t, model: resolvedModel };
          return { ...updatedBase, ...calculateTurnCost(updatedBase), _pricedVer: ENGINE_VERSION };
        });
      }
    }
  }
  return sessions;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export async function scanAllAntigravitySessionsAsync({ force = false } = {}) {
  ensureDiskCacheLoaded();
  const now = Date.now();
  if (!force && scanStateCache.antigravity.sessions && now - scanStateCache.antigravity.scannedAt < 2500) {
    return scanStateCache.antigravity.sessions;
  }

  const surfaces = [
    { dir: 'antigravity', label: 'Antigravity 2.0' },
    { dir: 'antigravity-cli', label: 'Antigravity CLI' },
    { dir: 'antigravity-ide', label: 'Antigravity IDE' }
  ];

  const sessions = [];
  const swarmModelMap = new Map();
  const fileMeta = scanStateCache.antigravity.fileMeta;

  for (const s of surfaces) {
    const surfaceRoot = path.join(HOME, '.gemini', s.dir);
    const brainDir = path.join(surfaceRoot, 'brain');
    if (!fs.existsSync(brainDir)) continue;

    const summaryMap = loadAntigravitySummaries(surfaceRoot);
    const logIndex = loadAntigravityLogIndex(surfaceRoot);
    const convsDir = path.join(surfaceRoot, 'conversations');
    let convFileNames = null;
    try {
      convFileNames = new Set(fs.readdirSync(convsDir));
    } catch {
      convFileNames = new Set();
    }

    let convDirs = [];
    try {
      convDirs = fs.readdirSync(brainDir, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      continue;
    }

    const parsedList = await mapWithConcurrency(convDirs, 24, async d => {
      const convId = d.name;
      const convDir = path.join(brainDir, convId);
      const transcriptPath = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
      const dbPath = path.join(convsDir, `${convId}.db`);
      const memo = fileMeta.get(transcriptPath);

      // Fast path: cold sessions unchanged for >12h skip repeated NTFS stat within 45s
      if (
        !force &&
        memo &&
        now - memo.mtimeMs > 12 * 3600 * 1000 &&
        now - memo.checkedAt < 45_000 &&
        fileCache.has(transcriptPath)
      ) {
        if (memo.swarmEntries) {
          for (const [cid, val] of memo.swarmEntries) swarmModelMap.set(cid, val);
        }
        const meta = {
          ...(summaryMap.get(convId) || {}),
          dbPath,
          dbSig: memo.dbSig,
          convFileNames,
          logIndex
        };
        const parsed = refreshSessionExternalBilling(
          parseAntigravityTranscript(transcriptPath, { mtimeMs: memo.mtimeMs, size: memo.size }, convId, s.label, meta),
          logIndex
        );
        return parsed.turns.length > 0 ? parsed : null;
      }

      // Parallel async stat for transcript + db/wal + swarm roster
      const membersPath = path.join(convDir, '.system_generated', 'swarm', 'members.json');
      const [trStat, dbSig, membersRaw] = await Promise.all([
        fsp.stat(transcriptPath).catch(() => null),
        dbSignatureAsync(dbPath, convFileNames),
        fsp.readFile(membersPath, 'utf8').catch(() => null)
      ]);

      let swarmEntries = null;
      if (membersRaw) {
        try {
          const roster = JSON.parse(membersRaw);
          swarmEntries = [];
          for (const [name, m] of Object.entries(roster?.members || {})) {
            if (!m?.conversation_id || m.role === 'coordinator') continue;
            const model = m.applied_model || m.model || m.desired_model;
            if (model) {
              swarmModelMap.set(m.conversation_id, { name, model });
              swarmEntries.push([m.conversation_id, { name, model }]);
            }
          }
        } catch {}
      }

      if (!trStat) return null;
      fileMeta.set(transcriptPath, {
        checkedAt: now,
        mtimeMs: trStat.mtimeMs,
        size: trStat.size,
        dbSig,
        swarmEntries
      });

      try {
        const meta = {
          ...(summaryMap.get(convId) || {}),
          dbPath,
          dbSig,
          convFileNames,
          logIndex
        };
        const parsed = refreshSessionExternalBilling(
          parseAntigravityTranscript(transcriptPath, trStat, convId, s.label, meta),
          logIndex
        );
        return parsed.turns.length > 0 ? parsed : null;
      } catch {
        return null;
      }
    });

    for (const p of parsedList) {
      if (p) sessions.push(p);
    }
  }

  const finalSessions = finalizeAntigravitySessions(sessions, swarmModelMap);
  scanStateCache.antigravity.sessions = finalSessions;
  scanStateCache.antigravity.scannedAt = Date.now();
  return finalSessions;
}

export function scanAllAntigravitySessions() {
  ensureDiskCacheLoaded();
  const surfaces = [
    { dir: 'antigravity', label: 'Antigravity 2.0' },
    { dir: 'antigravity-cli', label: 'Antigravity CLI' },
    { dir: 'antigravity-ide', label: 'Antigravity IDE' }
  ];

  const sessions = [];
  const swarmModelMap = new Map();
  for (const s of surfaces) {
    const surfaceRoot = path.join(HOME, '.gemini', s.dir);
    const brainDir = path.join(surfaceRoot, 'brain');
    if (!fs.existsSync(brainDir)) continue;

    const summaryMap = loadAntigravitySummaries(surfaceRoot);
    const logIndex = loadAntigravityLogIndex(surfaceRoot);
    const convsDir = path.join(surfaceRoot, 'conversations');
    let convFileNames = null;
    try {
      convFileNames = new Set(fs.readdirSync(convsDir));
    } catch {
      convFileNames = new Set();
    }
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
      let stat;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        continue;
      }
      try {
        const meta = {
          ...(summaryMap.get(convId) || {}),
          dbPath: path.join(convsDir, `${convId}.db`),
          convFileNames,
          logIndex
        };
        const parsed = refreshSessionExternalBilling(
          parseAntigravityTranscript(transcriptPath, stat, convId, s.label, meta),
          logIndex
        );
        if (parsed.turns.length > 0) {
          sessions.push(parsed);
        }
      } catch {}
    }
  }

  return finalizeAntigravitySessions(sessions, swarmModelMap);
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

function formatCodexModelWithEffort(rawModel, effort, defaultModel = 'gpt-6.2-sol') {
  const base = rawModel || defaultModel;
  if (!effort) return base;
  const eff = String(effort).toLowerCase();
  if (eff === 'ultra') return `${base} (Ultra)`;
  if (eff === 'max') return `${base} (Max)`;
  if (eff === 'xhigh') return `${base} (xHigh)`;
  if (eff === 'high') return `${base} (High)`;
  if (eff === 'medium') return `${base} (Medium)`;
  if (eff === 'low') return `${base} (Low)`;
  if (eff === 'minimal') return `${base} (Minimal)`;
  return base;
}

function parseCodexRolloutJsonl(filePath, stat, fallbackDefaults = {}) {
  const cacheKey = `codex_rollout:${filePath}`;
  const cached = fileCache.get(cacheKey);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.pricingVersion === ENGINE_VERSION &&
    cached.codexParserVersion === CODEX_PARSER_VERSION
  ) {
    return cached.data;
  }

  let sessionId = path.basename(filePath, '.jsonl').replace(/^rollout-[^-]+-/, '');
  let cwd = '';
  let activeModel = fallbackDefaults.model || 'gpt-6.2-sol';
  let activeEffort = fallbackDefaults.effort || '';
  let activeServiceTier = fallbackDefaults.serviceTier || 'default';
  let firstUserPrompt = '';
  let firstTimestamp = null;
  let lastTimestamp = null;
  let promptSeq = 0;
  let prevTotalTokens = 0;
  let prevInputTokens = 0;
  let prevCachedTokens = 0;
  let prevCacheWriteTokens = 0;
  let prevOutputTokens = 0;
  let prevReasoningTokens = 0;
  let lastTurnStartMs = null;
  let pendingToolCalls = 0;
  let latestRateLimits = null;
  let sawTaskStarted = false;
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
        if (obj.payload.service_tier) activeServiceTier = obj.payload.service_tier;
      } else if (obj.type === 'turn_context' && obj.payload) {
        if (obj.payload.cwd && !cwd) cwd = obj.payload.cwd;
        if (obj.payload.model) activeModel = obj.payload.model;
        if (obj.payload.effort || obj.payload.reasoning_effort) {
          activeEffort = obj.payload.effort || obj.payload.reasoning_effort;
        }
        if (obj.payload.service_tier) {
          activeServiceTier = obj.payload.service_tier;
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
        if (p.type === 'user_message' && p.message) {
          if (!firstUserPrompt) firstUserPrompt = cleanUserPreview(p.message);
          if (!sawTaskStarted) promptSeq += 1;
        }
        if (p.type === 'task_started') {
          sawTaskStarted = true;
          promptSeq += 1;
          if (!Number.isNaN(tsMs)) lastTurnStartMs = tsMs;
        }
        if (p.rate_limits) {
          const rl = p.rate_limits;
          const rlTs = tsStr || new Date(stat.mtimeMs).toISOString();
          const hasValidPrimary = rl.primary && typeof rl.primary.used_percent === 'number';
          const hasValidSecondary = rl.secondary && typeof rl.secondary.used_percent === 'number';
          const isCodexBucket = !rl.limit_id || rl.limit_id === 'codex';
          // Avoid letting secondary/empty buckets (e.g. limit_id: "premium" with null windows) overwrite valid codex limits
          if (hasValidPrimary || hasValidSecondary) {
            const prev = latestRateLimits || {};
            latestRateLimits = {
              ...prev,
              ...rl,
              primary: hasValidPrimary
                ? { ...rl.primary, _ts: rlTs }
                : prev.primary || null,
              secondary: hasValidSecondary
                ? { ...rl.secondary, _ts: rlTs }
                : prev.secondary || null,
              timestamp: rlTs
            };
          } else if (isCodexBucket && !latestRateLimits) {
            latestRateLimits = { ...rl, timestamp: rlTs };
          }
        }
        if (p.type === 'token_count' && p.info) {
          const lastUsage = p.info.last_token_usage;
          const totalUsage = p.info.total_token_usage;
          let inputTokens = 0;
          let cacheCreationTokens = 0;
          let cacheReadTokens = 0;
          let outputTokens = 0;
          let thinkingTokens = 0;

          if (totalUsage) {
            const curIn = Number(totalUsage.input_tokens || 0);
            const curCached = Number(totalUsage.cached_input_tokens || 0);
            const curCacheWrite = Number(totalUsage.cache_write_input_tokens || 0);
            const curOut = Number(totalUsage.output_tokens || 0);
            const curReas = Number(totalUsage.reasoning_output_tokens || 0);
            const curTot = Number(totalUsage.total_tokens || curIn + curOut);
            // Skip duplicate or non-increasing cumulative snapshots
            if (curTot <= prevTotalTokens) continue;
            const deltaIn = Math.max(0, curIn - prevInputTokens);
            cacheReadTokens = Math.max(0, curCached - prevCachedTokens);
            cacheCreationTokens = Math.max(0, curCacheWrite - prevCacheWriteTokens);
            inputTokens = Math.max(0, deltaIn - cacheReadTokens - cacheCreationTokens);
            outputTokens = Math.max(0, curOut - prevOutputTokens);
            thinkingTokens = Math.max(0, curReas - prevReasoningTokens);
            if (p.info.last_usage_includes_reasoning === false && thinkingTokens > 0 && curIn + curOut + curReas === curTot) {
              outputTokens += thinkingTokens;
            }
            prevInputTokens = curIn;
            prevCachedTokens = curCached;
            prevCacheWriteTokens = curCacheWrite;
            prevOutputTokens = curOut;
            prevReasoningTokens = curReas;
            prevTotalTokens = curTot;
          } else if (lastUsage && (lastUsage.input_tokens > 0 || lastUsage.output_tokens > 0)) {
            const rawIn = Number(lastUsage.input_tokens || 0);
            cacheReadTokens = Number(lastUsage.cached_input_tokens || 0);
            cacheCreationTokens = Number(lastUsage.cache_write_input_tokens || 0);
            inputTokens = Math.max(0, rawIn - cacheReadTokens - cacheCreationTokens);
            outputTokens = Number(lastUsage.output_tokens || 0);
            thinkingTokens = Number(lastUsage.reasoning_output_tokens || 0);
            if (p.info.last_usage_includes_reasoning === false && thinkingTokens > 0 && rawIn + outputTokens + thinkingTokens === Number(lastUsage.total_tokens || 0)) {
              outputTokens += thinkingTokens;
            }
            prevInputTokens += rawIn;
            prevCachedTokens += cacheReadTokens;
            prevCacheWriteTokens += cacheCreationTokens;
            prevOutputTokens += outputTokens;
            prevReasoningTokens += thinkingTokens;
            prevTotalTokens += Number(lastUsage.total_tokens || rawIn + outputTokens);
          }

          if (inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens <= 0) continue;

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

          const modelWithEffort = formatCodexModelWithEffort(activeModel, activeEffort, fallbackDefaults.model);
          const turnBase = {
            id: `${sessionId}_turn_${turns.length + 1}`,
            platform: 'gpt',
            surface: 'Codex',
            sessionId,
            promptSeq: promptSeq || 1,
            timestamp: tsStr || lastTimestamp || new Date(stat.mtimeMs).toISOString(),
            model: modelWithEffort,
            serviceTier: activeServiceTier,
            inputTokens,
            cacheCreationTokens,
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

  setFileCacheEntry(cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pricingVersion: ENGINE_VERSION,
    codexParserVersion: CODEX_PARSER_VERSION,
    data
  });
  return data;
}

function scanAllGptSessions({ force = false } = {}) {
  ensureDiskCacheLoaded();
  const now = Date.now();
  if (!force && scanStateCache.gpt.sessions && now - scanStateCache.gpt.scannedAt < 2500) {
    return scanStateCache.gpt.sessions;
  }
  const codexRoot = path.join(HOME, '.codex');
  if (!fs.existsSync(codexRoot)) return [];

  const sessionMap = new Map();

  // 1. Read default model, reasoning effort & service_tier from ~/.codex/config.toml
  let defaultModel = 'gpt-6.2-sol';
  let defaultEffort = 'high';
  let defaultServiceTier = 'default';
  let defaultProjectPath = '';
  const configPath = path.join(codexRoot, 'config.toml');
  if (fs.existsSync(configPath)) {
    try {
      const toml = fs.readFileSync(configPath, 'utf8');
      const mMatch = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
      const eMatch = toml.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
      const sMatch = toml.match(/^\s*service_tier\s*=\s*"([^"]+)"/m);
      const pMatch = toml.match(/\[projects\.'([^']+)'\]/);
      if (mMatch) defaultModel = mMatch[1];
      if (eMatch) defaultEffort = eMatch[1];
      if (sMatch) defaultServiceTier = sMatch[1];
      if (pMatch) defaultProjectPath = pMatch[1];
    } catch {}
  }
  const rolloutFallback = { model: defaultModel, effort: defaultEffort, serviceTier: defaultServiceTier };

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
            const parsed = parseCodexRolloutJsonl(full, stat, rolloutFallback);
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
            const parsed = parseCodexRolloutJsonl(r.rollout_path, stat, rolloutFallback);
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
            disableLongContext: true,
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
      cached.pricingVersion === ENGINE_VERSION &&
      cached.codexParserVersion === CODEX_PARSER_VERSION
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
                 OR target = 'codex_skills_extension::shadow_selection_experiment'
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
              isShadowExperiment: false,
              rawSamplingSteps: []
            });
          }
          const st = byThread.get(tid);
          const rowTsMs = Number(r.ts) * 1000 + Math.round(Number(r.ts_nanos || 0) / 1e6);
          if (!st.firstTsMs || rowTsMs < st.firstTsMs) st.firstTsMs = rowTsMs;
          if (!st.lastTsMs || rowTsMs > st.lastTsMs) st.lastTsMs = rowTsMs;

          const body = String(r.feedback_log_body || '');
          if (
            r.target === 'codex_skills_extension::shadow_selection_experiment' ||
            body.includes('shadow_selection_experiment')
          ) {
            st.isShadowExperiment = true;
          }
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
          if (st.isShadowExperiment || st.rawSamplingSteps.length === 0) continue;
          const turns = [];
          const turnIdSeqMap = new Map();
          let prevTotal = 0;
          for (let idx = 0; idx < st.rawSamplingSteps.length; idx++) {
            const step = st.rawSamplingSteps[idx];
            if (!turnIdSeqMap.has(step.turnId)) {
              turnIdSeqMap.set(step.turnId, turnIdSeqMap.size + 1);
            }
            const stepPromptSeq = turnIdSeqMap.get(step.turnId);
            const curTotal = step.totalUsageTokens;
            if (idx > 0 && curTotal === prevTotal) continue;
            const turnDelta = idx === 0 || curTotal < prevTotal ? curTotal : curTotal - prevTotal;
            prevTotal = curTotal;
            if (turnDelta <= 0) continue;

            // `total_usage_tokens` in logs_2 is cumulative session/context usage; count ONLY the step delta.
            const cacheReadTokens = Math.round(turnDelta * 0.80);
            const outCap = idx === 0 ? 1200 : 2500;
            const outRatio = idx === 0 ? 0.03 : 0.15;
            const outputTokens = Math.min(
              turnDelta - cacheReadTokens,
              Math.min(outCap, Math.max(1, Math.round(turnDelta * outRatio)))
            );
            const inputTokens = Math.max(0, turnDelta - cacheReadTokens - outputTokens);

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
              promptSeq: stepPromptSeq,
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

        setFileCacheEntry(cacheKey, {
          mtimeMs: combinedMtime,
          size: combinedSize,
          pricingVersion: ENGINE_VERSION,
          codexParserVersion: CODEX_PARSER_VERSION,
          data: logSessions
        });
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

  const finalSessions = Array.from(sessionMap.values());
  scanStateCache.gpt.sessions = finalSessions;
  scanStateCache.gpt.scannedAt = Date.now();
  return finalSessions;
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

function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// 3.5 Official Live Quota Discovery: Claude Code OAuth API (`https://api.anthropic.com/api/oauth/usage`)
async function fetchClaudeOfficialOAuthQuota({ force = false } = {}) {
  const now = Date.now();
  const cached5hResetMs = parseResetTimestampMs(cachedClaudeOAuthQuota.payload?.fiveHour?.resetsAt);
  const cached7dResetMs = parseResetTimestampMs(cachedClaudeOAuthQuota.payload?.sevenDay?.resetsAt);
  const hasExpiredWindow =
    (!Number.isNaN(cached5hResetMs) && now >= cached5hResetMs) ||
    (!Number.isNaN(cached7dResetMs) && now >= cached7dResetMs);

  if (!force && !hasExpiredWindow && now - cachedClaudeOAuthQuota.checkedAt < 45_000) {
    if (cachedClaudeOAuthQuota.payload || now - cachedClaudeOAuthQuota.checkedAt < 30_000) {
      return cachedClaudeOAuthQuota.payload;
    }
  }
  const credPath = path.join(HOME, '.claude', '.credentials.json');
  if (!fs.existsSync(credPath)) {
    quotaSyncDiagnostics.claude = {
      status: 'missing',
      source: null,
      syncedAt: quotaSyncDiagnostics.claude.syncedAt,
      reason: '未找到 ~/.claude/.credentials.json，无法直连 Claude 官方 OAuth'
    };
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    const oauth = raw?.claudeAiOauth;
    const accessToken = oauth?.accessToken;
    if (!accessToken) {
      quotaSyncDiagnostics.claude = {
        status: 'missing',
        source: null,
        syncedAt: quotaSyncDiagnostics.claude.syncedAt,
        reason: 'Claude OAuth 凭证缺少 accessToken'
      };
      return null;
    }
    if (oauth.expiresAt && Number(oauth.expiresAt) < now - 60_000) {
      const expIso = new Date(Number(oauth.expiresAt)).toISOString();
      quotaSyncDiagnostics.claude = {
        status: 'auth_expired',
        source: 'claude_oauth_api',
        syncedAt: quotaSyncDiagnostics.claude.syncedAt,
        reason: `Claude OAuth 凭证已于 ${expIso.slice(0, 16).replace('T', ' ')} UTC 过期，运行一次 Claude Code 后会自动恢复直连`
      };
      return null;
    }

    cachedClaudeOAuthQuota.checkedAt = now;
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json'
      },
      signal: AbortSignal.timeout(force ? 4000 : 2200)
    }).catch(() => null);

    if (!res?.ok) {
      quotaSyncDiagnostics.claude = {
        status: res?.status === 401 ? 'auth_expired' : 'offline',
        source: 'claude_oauth_api',
        syncedAt: quotaSyncDiagnostics.claude.syncedAt,
        reason: res ? `Claude OAuth API 返回 HTTP ${res.status}` : 'Claude OAuth API 网络超时或不可达'
      };
      return cachedClaudeOAuthQuota.payload;
    }
    const data = await res.json().catch(() => null);
    if (!data || (!data.five_hour && !data.seven_day)) return cachedClaudeOAuthQuota.payload;

    const fh = data.five_hour;
    const sd = data.seven_day;
    const bd = data.seven_day_breakdown;
    const syncedIso = new Date(now).toISOString();

    const payload = {
      source: 'claude_oauth_api',
      syncedAt: syncedIso,
      fiveHour: fh
        ? {
            usedPercentage: typeof fh.utilization === 'number' ? Number(fh.utilization) : null,
            resetsAt: fh.resets_at || null,
            asOf: syncedIso
          }
        : null,
      sevenDay: sd
        ? {
            usedPercentage: typeof sd.utilization === 'number' ? Number(sd.utilization) : null,
            resetsAt: sd.resets_at || null,
            windowStartedAt: bd?.window_started_at || null,
            asOf: bd?.as_of || syncedIso
          }
        : null,
      subscriptionType: oauth.subscriptionType || null,
      rateLimitTier: oauth.rateLimitTier || null
    };

    cachedClaudeOAuthQuota.payload = payload;
    quotaSyncDiagnostics.claude = {
      status: 'live',
      source: 'claude_oauth_api',
      syncedAt: syncedIso,
      reason: '已实时读取 Claude 官方 OAuth 5H / 7D 重置时间'
    };
    saveLiveQuota('claude', payload);
    return payload;
  } catch (err) {
    quotaSyncDiagnostics.claude = {
      status: 'offline',
      source: 'claude_oauth_api',
      syncedAt: quotaSyncDiagnostics.claude.syncedAt,
      reason: err?.message || '读取 Claude 官方 OAuth 失败'
    };
    return cachedClaudeOAuthQuota.payload;
  }
}

// 3.6 Official Live Quota Discovery: OpenAI Codex / ChatGPT API (`https://chatgpt.com/backend-api/wham/usage`)
async function fetchCodexOfficialQuota({ force = false } = {}) {
  const now = Date.now();
  const cached5hResetMs = parseResetTimestampMs(cachedCodexOfficialQuota.payload?.fiveHour?.resetsAt);
  const cached7dResetMs = parseResetTimestampMs(cachedCodexOfficialQuota.payload?.sevenDay?.resetsAt);
  const hasExpiredWindow =
    (!Number.isNaN(cached5hResetMs) && now >= cached5hResetMs) ||
    (!Number.isNaN(cached7dResetMs) && now >= cached7dResetMs);

  if (!force && !hasExpiredWindow && now - cachedCodexOfficialQuota.checkedAt < 25_000) {
    if (cachedCodexOfficialQuota.payload || now - cachedCodexOfficialQuota.checkedAt < 25_000) {
      return cachedCodexOfficialQuota.payload;
    }
  }

  const authPath = path.join(HOME, '.codex', 'auth.json');
  if (!fs.existsSync(authPath)) {
    quotaSyncDiagnostics.gpt = {
      status: 'missing',
      source: null,
      syncedAt: quotaSyncDiagnostics.gpt.syncedAt,
      reason: '未找到 ~/.codex/auth.json'
    };
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const accessToken = raw?.tokens?.access_token;
    if (!accessToken) {
      quotaSyncDiagnostics.gpt = {
        status: 'missing',
        source: null,
        syncedAt: quotaSyncDiagnostics.gpt.syncedAt,
        reason: 'Codex auth.json 缺少 access_token'
      };
      return null;
    }

    const authInfo = loadCodexAuthInfo();
    const accountId = raw?.tokens?.account_id || raw?.account_id || authInfo?.accountId || null;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent': 'codex-cli'
    };
    if (accountId) {
      headers['ChatGPT-Account-Id'] = accountId;
    }

    cachedCodexOfficialQuota.checkedAt = now;
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(force ? 4500 : 2500)
    }).catch(() => null);

    if (!res?.ok) {
      quotaSyncDiagnostics.gpt = {
        status: res?.status === 401 ? 'auth_expired' : 'offline',
        source: 'codex_wham_api',
        syncedAt: quotaSyncDiagnostics.gpt.syncedAt,
        reason: res ? `Codex WHAM API 返回 HTTP ${res.status}` : 'Codex WHAM API 网络超时或不可达'
      };
      return hasExpiredWindow ? null : cachedCodexOfficialQuota.payload;
    }
    const data = await res.json().catch(() => null);
    if (!data || !data.rate_limit) {
      return hasExpiredWindow ? null : cachedCodexOfficialQuota.payload;
    }

    const rl = data.rate_limit;
    const syncedIso = new Date(now).toISOString();
    const toWindowObj = (win, fallbackSeconds) => {
      if (!win || typeof win.used_percent !== 'number') return null;
      let resetsAt = null;
      if (win.reset_at) {
        const resetMs = parseResetTimestampMs(win.reset_at);
        if (!Number.isNaN(resetMs)) resetsAt = new Date(resetMs).toISOString();
      } else if (typeof win.reset_after_seconds === 'number') {
        resetsAt = new Date(now + win.reset_after_seconds * 1000).toISOString();
      }
      return {
        usedPercentage: Number(win.used_percent),
        windowSeconds: Number(win.limit_window_seconds || fallbackSeconds),
        resetsAt,
        asOf: syncedIso
      };
    };

    const payload = {
      source: 'codex_wham_api',
      syncedAt: syncedIso,
      email: data.email || authInfo?.email || null,
      accountId: data.account_id || accountId,
      planType: data.plan_type ? String(data.plan_type).toLowerCase() : authInfo?.planType || null,
      allowed: rl.allowed ?? null,
      limitReached: rl.limit_reached ?? null,
      fiveHour: toWindowObj(rl.primary_window, 18000),
      sevenDay: toWindowObj(rl.secondary_window, 604800)
    };

    cachedCodexOfficialQuota.payload = payload;
    quotaSyncDiagnostics.gpt = {
      status: 'live',
      source: 'codex_wham_api',
      syncedAt: syncedIso,
      reason: '已实时读取 Codex 官方 5H / 7D 重置时间'
    };
    saveLiveQuota('gpt', payload);
    return payload;
  } catch (err) {
    quotaSyncDiagnostics.gpt = {
      status: 'offline',
      source: 'codex_wham_api',
      syncedAt: quotaSyncDiagnostics.gpt.syncedAt,
      reason: err?.message || '读取 Codex 官方配额失败'
    };
    return hasExpiredWindow ? null : cachedCodexOfficialQuota.payload;
  }
}

// Fast local discovery for Antigravity language_server daemon:
// Primary: `~/.gemini/antigravity/daemon/hub_<httpPort>.json` (< 2ms, zero child processes)
// Secondary: scan live `hub_*.json` by mtime + PID liveness
// Fallback (legacy builds): async PowerShell process lookup
async function discoverAntigravityDaemon({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedLsAuth.httpPort &&
    cachedLsAuth.csrfToken &&
    (!cachedLsAuth.pid || isProcessAlive(cachedLsAuth.pid))
  ) {
    return cachedLsAuth;
  }

  let logPid = null;
  let logPort = null;
  const lsLog = path.join(HOME, 'AppData', 'Roaming', 'Antigravity', 'logs', 'language_server.log');
  try {
    const st = fs.statSync(lsLog);
    if (st.mtimeMs === cachedLsLogMeta.mtimeMs && st.size === cachedLsLogMeta.size && cachedLsLogMeta.httpPort) {
      logPid = cachedLsLogMeta.pid;
      logPort = cachedLsLogMeta.httpPort;
    } else {
      const logContent = fs.readFileSync(lsLog, 'utf8');
      logPid = [...logContent.matchAll(/Starting language server process with pid (\d+)/g)].at(-1)?.[1] || null;
      logPort = [...logContent.matchAll(/listening on random port at (\d+) for HTTP\b/g)].at(-1)?.[1] || null;
      cachedLsLogMeta = { mtimeMs: st.mtimeMs, size: st.size, pid: logPid, httpPort: logPort };
    }
  } catch {}

  const daemonDirs = [
    path.join(HOME, '.gemini', 'antigravity', 'daemon'),
    path.join(HOME, '.gemini', 'antigravity-ide', 'daemon'),
    path.join(HOME, '.gemini', 'antigravity-cli', 'daemon')
  ];

  // 1. Direct hit by port from language_server.log
  if (logPort) {
    for (const dDir of daemonDirs) {
      const exactPath = path.join(dDir, `hub_${logPort}.json`);
      try {
        if (fs.existsSync(exactPath)) {
          const hub = JSON.parse(fs.readFileSync(exactPath, 'utf8'));
          if (hub?.httpPort && hub?.csrfToken && (!hub.pid || isProcessAlive(hub.pid))) {
            cachedLsAuth = {
              pid: String(hub.pid || logPid || ''),
              httpPort: String(hub.httpPort),
              csrfToken: hub.csrfToken,
              lsVersion: hub.lsVersion || null,
              checkedAt: now
            };
            return cachedLsAuth;
          }
        }
      } catch {}
    }
  }

  // 2. Scan daemon hub_*.json sorted by mtime desc and pick the newest alive daemon
  const candidates = [];
  for (const dDir of daemonDirs) {
    try {
      if (!fs.existsSync(dDir)) continue;
      for (const name of fs.readdirSync(dDir)) {
        if (!/^hub_\d+\.json$/i.test(name)) continue;
        const full = path.join(dDir, name);
        try {
          const st = fs.statSync(full);
          candidates.push({ full, mtimeMs: st.mtimeMs });
        } catch {}
      }
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const cand of candidates.slice(0, 12)) {
    try {
      const hub = JSON.parse(fs.readFileSync(cand.full, 'utf8'));
      if (hub?.httpPort && hub?.csrfToken && (!hub.pid || isProcessAlive(hub.pid))) {
        cachedLsAuth = {
          pid: String(hub.pid || ''),
          httpPort: String(hub.httpPort),
          csrfToken: hub.csrfToken,
          lsVersion: hub.lsVersion || null,
          checkedAt: now
        };
        return cachedLsAuth;
      }
    } catch {}
  }

  // 3. Legacy fallback (older Antigravity builds passing --csrf_token on argv): non-blocking async execFile
  if (logPort && (forceRefresh || now - cachedLsAuth.checkedAt > 30_000)) {
    cachedLsAuth.checkedAt = now;
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name = 'language_server.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"
        ],
        { encoding: 'utf8', timeout: 3000, windowsHide: true }
      );
      const proc = JSON.parse(stdout);
      const list = Array.isArray(proc) ? proc : proc ? [proc] : [];
      const matched = list.find(p => String(p.ProcessId) === String(logPid)) || list[0];
      const csrf = matched?.CommandLine?.match(/--csrf_token[=\s]+([^\s"]+)/)?.[1] || null;
      if (csrf) {
        cachedLsAuth = {
          pid: String(matched?.ProcessId || logPid || ''),
          httpPort: String(logPort),
          csrfToken: csrf,
          lsVersion: null,
          checkedAt: now
        };
        return cachedLsAuth;
      }
    } catch {}
  }

  return null;
}

// 4. Official Local Quota Discovery: Antigravity `language_server.exe` RPC (`GetUserStatus` + `RetrieveUserQuotaSummary`)
export async function fetchAntigravityOfficialQuota({ force = false } = {}) {
  const now = Date.now();
  const cachedPools = cachedAgyOfficialQuota.payload?.pools;
  const agyResetTimes = [
    cachedPools?.gemini?.resetsAt,
    cachedPools?.geminiWeekly?.resetsAt,
    cachedPools?.claude?.resetsAt,
    cachedPools?.claudeWeekly?.resetsAt
  ]
    .map(parseResetTimestampMs)
    .filter(ms => !Number.isNaN(ms));
  const hasExpiredWindow = agyResetTimes.some(ms => now >= ms);

  if (!force && !hasExpiredWindow && now - cachedAgyOfficialQuota.checkedAt < 15_000) {
    if (cachedAgyOfficialQuota.payload || now - cachedAgyOfficialQuota.checkedAt < 10_000) {
      return cachedAgyOfficialQuota.payload;
    }
  }

  try {
    let auth = await discoverAntigravityDaemon({ forceRefresh: force });
    if (!auth?.httpPort || !auth?.csrfToken) {
      quotaSyncDiagnostics.antigravity = {
        status: 'offline',
        source: 'language_server_rpc',
        syncedAt: quotaSyncDiagnostics.antigravity.syncedAt,
        reason: '未检测到运行中的 Antigravity LanguageServer（请确认 Antigravity 已打开）'
      };
      return null;
    }

    const callRpc = async targetAuth => {
      const rpcHeaders = {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': targetAuth.csrfToken
      };
      const timeoutMs = force ? 3500 : 1800;
      return Promise.all([
        fetch(
          `http://127.0.0.1:${targetAuth.httpPort}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
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
            signal: AbortSignal.timeout(timeoutMs)
          }
        ).catch(() => null),
        fetch(
          `http://127.0.0.1:${targetAuth.httpPort}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
          {
            method: 'POST',
            headers: rpcHeaders,
            body: JSON.stringify({ forceRefresh: Boolean(force || hasExpiredWindow) }),
            signal: AbortSignal.timeout(timeoutMs)
          }
        ).catch(() => null)
      ]);
    };

    cachedAgyOfficialQuota.checkedAt = now;
    let [statusRes, summaryRes] = await callRpc(auth);

    // If cached daemon restarted or token rotated, rediscover once and retry
    if (!statusRes?.ok && !summaryRes?.ok) {
      cachedLsAuth = { pid: null, httpPort: null, csrfToken: null, lsVersion: null, checkedAt: 0 };
      const freshAuth = await discoverAntigravityDaemon({ forceRefresh: true });
      if (freshAuth?.httpPort && freshAuth?.csrfToken && freshAuth.httpPort !== auth.httpPort) {
        auth = freshAuth;
        [statusRes, summaryRes] = await callRpc(auth);
      }
    }

    if (!statusRes?.ok && !summaryRes?.ok) {
      quotaSyncDiagnostics.antigravity = {
        status: 'offline',
        source: 'language_server_rpc',
        syncedAt: quotaSyncDiagnostics.antigravity.syncedAt,
        reason: `Antigravity RPC 请求失败 (port ${auth.httpPort})`
      };
      return hasExpiredWindow ? null : cachedAgyOfficialQuota.payload;
    }

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
    try {
      syncRpcModels(configs);
    } catch {}
    if (!gemini5h) {
      const geminiConfig =
        configs.find(c => /gemini-4-carbon-high/i.test(c.modelId)) ||
        configs.find(c => /gemini-4-argon-high/i.test(c.modelId)) ||
        configs.find(c => /gemini-4-neon-high/i.test(c.modelId)) ||
        configs.find(c => /gemini-4-hydrogen-high/i.test(c.modelId)) ||
        configs.find(c => /gemini-pro-orchestrator/i.test(c.modelId)) ||
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

    const syncedIso = new Date(now).toISOString();
    const payload = {
      source: 'language_server_rpc',
      syncedAt: syncedIso,
      lsVersion: auth.lsVersion || null,
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

    cachedAgyOfficialQuota.payload = payload;
    quotaSyncDiagnostics.antigravity = {
      status: 'live',
      source: 'language_server_rpc',
      syncedAt: syncedIso,
      reason: `已直连 Antigravity LS${auth.lsVersion ? ` v${auth.lsVersion}` : ''} · 实时读取双池 5H / 7D 重置时间`
    };
    saveLiveQuota('antigravity', payload);
    return payload;
  } catch (err) {
    quotaSyncDiagnostics.antigravity = {
      status: 'offline',
      source: 'language_server_rpc',
      syncedAt: quotaSyncDiagnostics.antigravity.syncedAt,
      reason: err?.message || '读取 Antigravity 官方配额异常'
    };
    return hasExpiredWindow ? null : cachedAgyOfficialQuota.payload;
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
  startGraceMs = 45 * 1000,
  resetInfo = null
}) {
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const START_GRACE_MS = Math.max(0, Number(startGraceMs ?? 45 * 1000));
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

    const startNotePrefix = resetInfo?.mode === 'in_cycle' ? '周内重置起算 ' : resetInfo?.mode === 'recalculate' ? '重算起算 ' : '';
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
          ? `${startNotePrefix}${toLocalHM(effStartMs)} 起算`
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

  // 4. Compute raw weekly quota % per day (calibrated so sum across cycle days equals `sevenDayUsedPct`)
  const totalCycleCostUsd = cycleTurns.reduce((s, t) => s + t.totalCostUsd, 0);
  const targetWeekUsedPct = Math.max(0, Number(sevenDayUsedPct || 0));
  const safe7dBudget = Math.max(0.01, Number(sevenDayBudgetUsd || 100));
  const safe5hBudget = Math.max(0.01, Number(fiveHourBudgetUsd || 20));

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
      const turnsInWinOnDay = d.turnsList.filter(
        t => t.ts >= w.startMs && t.ts < w.endMs
      );
      if (turnsInWinOnDay.length > 0) {
        const winCostOnDay = turnsInWinOnDay.reduce((s, t) => s + t.totalCostUsd, 0);
        const winPctLoad = Math.min(100, Number(((winCostOnDay / safe5hBudget) * 100).toFixed(1)));
        const firstTs = turnsInWinOnDay[0].ts;
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
    naturalCycleStartAt: resetInfo?.naturalCycleStartAt || new Date(effEndMs - SEVEN_D_MS).toISOString(),
    naturalResetsAt: resetInfo?.naturalResetsAt || new Date(effEndMs).toISOString(),
    resetMode: resetInfo?.mode || 'natural',
    resetSource: resetInfo?.source || 'official',
    resetAt: resetInfo?.resetAt || null,
    resetNote: resetInfo?.note || null,
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

function historyRecordsToOfficialPastCycles(records = [], sourceFallback = '官方周期记录') {
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const out = [];
  for (const r of records) {
    if (!r || !r.resetsAt || typeof r.usedPercentage !== 'number') continue;
    const endMs = parseResetTimestampMs(r.resetsAt);
    if (Number.isNaN(endMs)) continue;
    const startParsed = r.cycleStartAt ? Date.parse(r.cycleStartAt) : NaN;
    const startMs = !Number.isNaN(startParsed) && startParsed < endMs ? startParsed : endMs - SEVEN_D_MS;
    const natResetMs = r.naturalResetsAt ? parseResetTimestampMs(r.naturalResetsAt) : endMs;
    out.push({
      startMs,
      endMs,
      naturalResetsAtMs: Number.isNaN(natResetMs) ? endMs : natResetMs,
      usedPct: Number(r.usedPercentage),
      sourceLabel: r.source || sourceFallback,
      isResetArchive: Boolean(r.isResetArchive),
      resetMode: r.resetMode || 'natural',
      resetSource: r.resetSource || 'official'
    });
  }
  return out;
}

function buildWeeklyHistoryCycles({
  sortedTurns,
  currentCycleStartMs,
  sevenDayBudgetUsd,
  fiveHourBudgetUsd,
  officialPastCycles = [],
  nowMs = Date.now(),
  currentResetMode = 'natural'
}) {
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const START_GRACE_MS = 45 * 1000;
  const currentStartGrace = currentResetMode !== 'natural' ? 0 : START_GRACE_MS;
  const safe7dBudget = Math.max(0.01, Number(sevenDayBudgetUsd || 100));
  const safe5hBudget = Math.max(0.01, Number(fiveHourBudgetUsd || 20));
  const effCurrentStartMs = currentCycleStartMs || nowMs - SEVEN_D_MS;

  const pastTurns = sortedTurns.filter(t => t.ts < effCurrentStartMs - currentStartGrace);

  // Filter out unsealed duplicates that share a naturalResetsAt with an explicitly sealed reset archive
  const archiveNatEndList = officialPastCycles
    .filter(o => o && o.isResetArchive && Number.isFinite(o.naturalResetsAtMs))
    .map(o => ({ startMs: o.startMs, endMs: o.endMs, natMs: o.naturalResetsAtMs }));

  const filteredOfficial = officialPastCycles.filter(o => {
    if (!o || !Number.isFinite(o.endMs) || !Number.isFinite(o.startMs)) return false;
    if (o.endMs > effCurrentStartMs + 15 * 60_000) return false;
    if (!o.isResetArchive) {
      const shadowed = archiveNatEndList.some(
        a =>
          Math.abs(o.endMs - a.natMs) <= 2 * 3600 * 1000 &&
          o.startMs < a.endMs &&
          o.endMs > a.startMs
      );
      if (shadowed) return false;
    }
    return true;
  });

  // Deduplicate & sort official past cycle records ascending by endMs
  const rawOff = filteredOfficial
    .map(o => ({
      startMs: o.startMs,
      endMs: Math.min(o.endMs, effCurrentStartMs),
      naturalResetsAtMs: Number.isFinite(o.naturalResetsAtMs) ? o.naturalResetsAtMs : o.endMs,
      usedPct: typeof o.usedPct === 'number' ? o.usedPct : null,
      sourceLabel: o.sourceLabel || '官方周期记录',
      isResetArchive: Boolean(o.isResetArchive),
      resetMode: o.resetMode || 'natural',
      resetSource: o.resetSource || 'official'
    }))
    .filter(o => o.endMs > o.startMs + 15_000)
    .sort((a, b) => a.endMs - b.endMs);

  const dedupOff = [];
  for (const o of rawOff) {
    const prev = dedupOff.at(-1);
    const bothAreNormal = prev && !prev.isResetArchive && !o.isResetArchive;
    const sameCloseSegment =
      prev &&
      Math.abs(o.endMs - prev.endMs) <= (bothAreNormal ? 2 * 3600 * 1000 : 15 * 60 * 1000) &&
      (bothAreNormal || Math.abs(o.startMs - prev.startMs) <= 15 * 60 * 1000);

    if (sameCloseSegment) {
      if (o.isResetArchive && !prev.isResetArchive) {
        dedupOff[dedupOff.length - 1] = { ...o };
      } else if (!o.isResetArchive && prev.isResetArchive) {
        // Keep the explicit reset archive
      } else {
        if (o.usedPct !== null && (prev.usedPct === null || o.usedPct >= prev.usedPct)) {
          prev.usedPct = o.usedPct;
          prev.sourceLabel = o.sourceLabel;
        }
        prev.endMs = Math.max(prev.endMs, o.endMs);
        prev.startMs = Math.min(prev.startMs, o.startMs);
      }
    } else {
      dedupOff.push({ ...o });
    }
  }
  for (let i = 1; i < dedupOff.length; i++) {
    if (dedupOff[i].startMs < dedupOff[i - 1].endMs) {
      dedupOff[i].startMs = dedupOff[i - 1].endMs;
    }
  }

  const windows = [];
  const pushBackwardSlices = (fromMs, toMs, clampToFrom = true) => {
    let end = toMs;
    let safety = 0;
    while (end > fromMs + 60_000 && safety < 120) {
      safety++;
      const rawStart = end - SEVEN_D_MS;
      const start = clampToFrom ? Math.max(fromMs, rawStart) : rawStart;
      windows.push({
        startMs: start,
        endMs: end,
        naturalResetsAtMs: end,
        isOfficial: false,
        usedPct: null,
        sourceLabel: '按参考周预算估算',
        resetMode: 'natural',
        resetSource: 'estimated',
        isResetArchive: false
      });
      end = start;
    }
  };

  let cursorMs = effCurrentStartMs;
  for (let i = dedupOff.length - 1; i >= 0; i--) {
    const o = dedupOff[i];
    const effEnd = Math.min(o.endMs, cursorMs);
    const hasGapTurns =
      cursorMs - effEnd > 60_000 &&
      pastTurns.some(t => t.ts >= effEnd && t.ts < cursorMs - currentStartGrace);
    if (cursorMs - effEnd > 6 * 3600 * 1000 || hasGapTurns) {
      pushBackwardSlices(effEnd, cursorMs, true);
    }
    if (effEnd > o.startMs + 15_000) {
      windows.push({
        startMs: o.startMs,
        endMs: effEnd,
        naturalResetsAtMs: o.naturalResetsAtMs || effEnd,
        isOfficial: o.usedPct !== null,
        usedPct: o.usedPct,
        sourceLabel: o.sourceLabel,
        resetMode: o.resetMode || 'natural',
        resetSource: o.resetSource || 'official',
        isResetArchive: Boolean(o.isResetArchive)
      });
    }
    cursorMs = Math.min(cursorMs, o.startMs);
  }

  const earliestTurnTs = pastTurns[0]?.ts;
  if (earliestTurnTs && earliestTurnTs < cursorMs) {
    pushBackwardSlices(earliestTurnTs - 1, cursorMs, false);
  }

  // Sort newest-first and assign each past turn to at most one cycle
  windows.sort((a, b) => b.endMs - a.endMs);
  const assignedTurns = new Set();
  const cycles = [];

  for (const w of windows) {
    const winGrace = w.isResetArchive ? 0 : START_GRACE_MS;
    const wt = pastTurns.filter(t => {
      if (assignedTurns.has(t)) return false;
      if (t.ts >= w.startMs - winGrace && t.ts < w.endMs) {
        assignedTurns.add(t);
        return true;
      }
      return false;
    });
    if (wt.length === 0 && !w.isOfficial) continue;

    wt.sort((a, b) => a.ts - b.ts);
    const metrics = sumTurnMetrics(wt);
    const activeDaySet = new Set();
    let fiveHourWindowsCount = 0;
    let cur5hEndMs = 0;
    for (const t of wt) {
      activeDaySet.add(toLocalDateStr(t.ts));
      if (!cur5hEndMs || t.ts >= cur5hEndMs) {
        fiveHourWindowsCount++;
        cur5hEndMs = t.ts + FIVE_H_MS;
      }
    }

    const durationDays = Number(Math.max(0.1, (w.endMs - w.startMs) / DAY_MS).toFixed(1));
    const budgetRatioPct = Number(((metrics.costUsd / safe7dBudget) * 100).toFixed(1));
    const usedPercentage =
      w.isOfficial && typeof w.usedPct === 'number'
        ? Number(w.usedPct.toFixed(1))
        : budgetRatioPct;
    const natResetsAtMs = Number.isFinite(w.naturalResetsAtMs) ? w.naturalResetsAtMs : w.endMs;
    const isEarlyReset = Boolean(w.isResetArchive || natResetsAtMs > w.endMs + 15 * 60_000);

    cycles.push({
      index: cycles.length + 1,
      cycleStartAt: new Date(w.startMs).toISOString(),
      cycleEndAt: new Date(w.endMs).toISOString(),
      naturalResetsAt: new Date(natResetsAtMs).toISOString(),
      resetMode: w.resetMode || 'natural',
      resetSource: w.resetSource || 'official',
      isEarlyReset,
      durationDays,
      usedPercentage,
      isOfficialQuota: Boolean(w.isOfficial && typeof w.usedPct === 'number'),
      quotaSourceLabel: w.sourceLabel,
      budgetUsd: Number(safe7dBudget.toFixed(2)),
      budgetRatioPct,
      costUsd: Number(metrics.costUsd.toFixed(2)),
      avgDailyCostUsd: Number((metrics.costUsd / Math.max(1, durationDays)).toFixed(2)),
      activeDaysCount: activeDaySet.size,
      fiveHourWindowsCount,
      fiveHourEquivalents: Number((metrics.costUsd / safe5hBudget).toFixed(2)),
      turns: metrics.turns,
      totalTokens: metrics.totalTokens,
      inputTokens: metrics.inputTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      outputTokens: metrics.outputTokens,
      avgTps: metrics.avgTps,
      peakTps: metrics.peakTps
    });
  }

  const cyclesCount = cycles.length;
  const officialCyclesCount = cycles.filter(c => c.isOfficialQuota).length;
  const totalCostUsd = Number(cycles.reduce((s, c) => s + c.costUsd, 0).toFixed(2));
  const avgCostUsd = cyclesCount > 0 ? Number((totalCostUsd / cyclesCount).toFixed(2)) : 0;
  const maxCostUsd = cyclesCount > 0 ? Number(Math.max(...cycles.map(c => c.costUsd)).toFixed(2)) : 0;
  const avgUsedPct =
    cyclesCount > 0
      ? Number((cycles.reduce((s, c) => s + c.usedPercentage, 0) / cyclesCount).toFixed(1))
      : 0;
  const totalTurns = cycles.reduce((s, c) => s + c.turns, 0);
  const totalTokens = cycles.reduce((s, c) => s + c.totalTokens, 0);
  const totalFiveHourWindows = cycles.reduce((s, c) => s + c.fiveHourWindowsCount, 0);
  const avgFiveHourWindows =
    cyclesCount > 0 ? Number((totalFiveHourWindows / cyclesCount).toFixed(1)) : 0;

  return {
    cyclesCount,
    officialCyclesCount,
    estimatedCyclesCount: cyclesCount - officialCyclesCount,
    totalCostUsd,
    avgCostUsd,
    maxCostUsd,
    avgUsedPct,
    totalTurns,
    totalTokens,
    totalFiveHourWindows,
    avgFiveHourWindows,
    earliestCycleStartAt: cycles.at(-1)?.cycleStartAt || null,
    latestCycleEndAt: cycles[0]?.cycleEndAt || null,
    cycles
  };
}

// Unified Weekly Cycle & Quota-Reset Resolution Engine
// Handles: (1) normal natural cycle, (2) in_cycle reset (preserves naturalResetsAt), (3) recalculate reset (new naturalResetsAt = resetAt + windowMs)
function resolveWeeklyCycleWithResets({
  poolKey,
  nowMs,
  windowMs = SEVEN_D_MS_CONST,
  baseCycleStartMs,
  baseResetsAtMs,
  baseUsedPct,
  baseUsedExact = null,
  baseNativeRemPct = null,
  baseAsOfMs = null,
  baseIsOfficial = false,
  baseSourceLabel = '',
  baseStartGraceMs = 45 * 1000,
  resetRecord = null,
  sortedTurns = [],
  defaultBudgetUsd = 100,
  initialCalibratedBudgetUsd = null,
  minBudgetCost = 2,
  minBudgetPct = 5,
  inCycleSampleResetMs = null
}) {
  const safeDefaultBudget = Math.max(0.01, Number(defaultBudgetUsd || 100));
  let budgetUsd = initialCalibratedBudgetUsd && initialCalibratedBudgetUsd > 0
    ? initialCalibratedBudgetUsd
    : safeDefaultBudget;

  const ov = resetRecord?.activeOverride || null;
  let effectiveStartMs = baseCycleStartMs;
  let effectiveResetsAtMs = baseResetsAtMs;
  let naturalCycleStartMs = effectiveResetsAtMs
    ? effectiveResetsAtMs - windowMs
    : effectiveStartMs;
  let startGraceMs = baseStartGraceMs;

  let mode = 'natural';
  let source = baseIsOfficial ? 'official' : 'estimated';
  let resetAtMs = null;
  let resetNote = null;
  let hasActiveOverride = false;
  let isManualOverride = false;
  let useOfficialPct = Boolean(baseIsOfficial && typeof baseUsedPct === 'number');
  let allowBudgetCalibration = useOfficialPct;
  let finalSourceLabel = baseSourceLabel;

  // Check if a manual/auto override is active and not yet expired
  const ovResetMs = ov?.resetAt ? Date.parse(ov.resetAt) : NaN;
  const ovNatResetMs = ov?.naturalResetsAt ? Date.parse(ov.naturalResetsAt) : NaN;
  const ovActive = ov && Number.isFinite(ovResetMs) && Number.isFinite(ovNatResetMs) && nowMs < ovNatResetMs;

  // Also check if `lastAnchorResetsAt` exists from a past `recalculate` override when no fresh official future resetsAt is present
  const anchorMs = resetRecord?.lastAnchorResetsAt ? Date.parse(resetRecord.lastAnchorResetsAt) : NaN;
  if (!ovActive && !baseIsOfficial && Number.isFinite(anchorMs)) {
    let steppedReset = anchorMs;
    while (nowMs >= steppedReset) {
      steppedReset += windowMs;
    }
    if (!effectiveResetsAtMs || Math.abs(effectiveResetsAtMs - steppedReset) > CLUSTER_TOLERANCE_MS_CONST) {
      effectiveResetsAtMs = steppedReset;
      effectiveStartMs = steppedReset - windowMs;
      naturalCycleStartMs = effectiveStartMs;
      startGraceMs = 0;
    }
  }

  if (ovActive) {
    hasActiveOverride = true;
    isManualOverride = ov.source === 'manual';
    mode = ov.mode === 'recalculate' ? 'recalculate' : 'in_cycle';
    source = ov.source || 'manual';
    resetAtMs = ovResetMs;
    effectiveStartMs = ovResetMs;
    effectiveResetsAtMs = ovNatResetMs;
    naturalCycleStartMs = ovNatResetMs - windowMs;
    startGraceMs = ov.source === 'manual' ? 0 : 1000;

    if (ov.source === 'auto') {
      const sameWindow =
        baseIsOfficial &&
        Number.isFinite(baseResetsAtMs) &&
        Math.abs(baseResetsAtMs - ovNatResetMs) <= CLUSTER_TOLERANCE_MS_CONST;
      useOfficialPct = Boolean(sameWindow && typeof baseUsedPct === 'number');
      allowBudgetCalibration = useOfficialPct;
      const timeTag = toLocalHMS(ovResetMs);
      resetNote =
        mode === 'in_cycle'
          ? `已自动识别周内重置 (自 ${timeTag} 起重算消耗 · 原自然重置时间不变)`
          : `已自动识别完全重置 (自 ${timeTag} 起重算新自然重置周期)`;
      finalSourceLabel = `${baseSourceLabel ? baseSourceLabel + ' · ' : ''}${mode === 'in_cycle' ? '周内重置已对齐' : '自然周期已重算'}`;
    } else {
      // Manual override: determine whether official feed has genuinely synced with the reset
      const snapUsed = Number(ov.snapshotUsedPctAtReset ?? 0);
      const snapResetMs = ov.snapshotResetsAtAtReset ? Date.parse(ov.snapshotResetsAtAtReset) : NaN;
      const officialAsOf = Number.isFinite(baseAsOfMs) ? baseAsOfMs : 0;

      let officialSynced = false;
      if (mode === 'in_cycle') {
        const sameNat =
          baseIsOfficial &&
          Number.isFinite(baseResetsAtMs) &&
          Math.abs(baseResetsAtMs - ovNatResetMs) <= CLUSTER_TOLERANCE_MS_CONST;
        if (sameNat && typeof baseUsedPct === 'number') {
          if (snapUsed >= 5 && (baseUsedPct <= 1 || snapUsed - baseUsedPct >= 15) && officialAsOf >= ovResetMs - 60_000) {
            officialSynced = true;
          } else if (snapUsed <= 1 && officialAsOf > ovResetMs + 2_000) {
            officialSynced = true;
          }
        }
      } else if (mode === 'recalculate') {
        if (
          baseIsOfficial &&
          Number.isFinite(baseResetsAtMs) &&
          baseResetsAtMs > nowMs &&
          officialAsOf > ovResetMs + 5_000 &&
          (!Number.isFinite(snapResetMs) || Math.abs(baseResetsAtMs - snapResetMs) > CLUSTER_TOLERANCE_MS_CONST) &&
          Math.abs(baseResetsAtMs - ovNatResetMs) <= 2 * 3600 * 1000
        ) {
          officialSynced = true;
        }
      }

      useOfficialPct = officialSynced;
      allowBudgetCalibration = officialSynced;
      const timeTag = toLocalHMS(ovResetMs);
      resetNote =
        mode === 'in_cycle'
          ? `手动周内重置 (自 ${timeTag} 起重算消耗 · 原自然重置时间不变)`
          : `手动完全重置 (自 ${timeTag} 起重算 7 天自然重置时间)`;
      finalSourceLabel =
        mode === 'in_cycle'
          ? `已应用周内重置 (${timeTag} 起算 · 保持原自然重置时间)`
          : `已应用完全重置 (${timeTag} 起算 · 已重算自然重置时间)`;
    }
  } else if (
    inCycleSampleResetMs &&
    Number.isFinite(effectiveStartMs) &&
    Number.isFinite(effectiveResetsAtMs) &&
    inCycleSampleResetMs > effectiveStartMs + 60_000 &&
    inCycleSampleResetMs < effectiveResetsAtMs
  ) {
    // Claude Desktop plan-usage-history.json detected an intra-cycle reset within the current natural week
    mode = 'in_cycle';
    source = 'auto';
    resetAtMs = inCycleSampleResetMs;
    effectiveStartMs = inCycleSampleResetMs;
    startGraceMs = 0;
    const timeTag = toLocalHMS(inCycleSampleResetMs);
    resetNote = `检测到采样周内重置 (自 ${timeTag} 起算 · 原自然重置时间不变)`;
    finalSourceLabel = `${baseSourceLabel ? baseSourceLabel + ' · ' : ''}周内重置已对齐`;
  } else {
    // Check if there was a recent recalculate event that matches current official natural cycle
    const recentRecalc = (resetRecord?.events || []).slice().reverse().find(e =>
      e.mode === 'recalculate' &&
      e.naturalResetsAt &&
      effectiveResetsAtMs &&
      Math.abs(Date.parse(e.naturalResetsAt) - effectiveResetsAtMs) <= CLUSTER_TOLERANCE_MS_CONST
    );
    if (recentRecalc) {
      mode = 'recalculate';
      source = recentRecalc.source || 'auto';
      resetAtMs = Date.parse(recentRecalc.resetAt);
      resetNote = recentRecalc.note || '当前周期为重置后重新计算的自然周期';
    }
  }

  // Filter turns strictly inside the resolved effective weekly window
  const turns7d = sortedTurns.filter(t => t.ts >= effectiveStartMs - startGraceMs);
  const stats7d = sumTurnMetrics(turns7d);

  // Calibrate 7d budget ONLY when official percentage corresponds to the same effective segment
  let finalUsedPct = null;
  let finalUsedExact = null;
  let finalNativeRemPct = null;

  if (useOfficialPct && typeof baseUsedPct === 'number') {
    finalUsedPct = Number(baseUsedPct);
    finalUsedExact = typeof baseUsedExact === 'number' ? Number(baseUsedExact) : finalUsedPct;
    finalNativeRemPct =
      typeof baseNativeRemPct === 'number'
        ? baseNativeRemPct
        : Math.round(Math.max(0, 100 - finalUsedPct));
    if (allowBudgetCalibration && finalUsedExact >= minBudgetPct && stats7d.costUsd >= minBudgetCost) {
      budgetUsd = Number((stats7d.costUsd / (finalUsedExact / 100)).toFixed(2));
    }
  } else {
    finalUsedPct = Math.min(100, (stats7d.costUsd / budgetUsd) * 100);
    finalUsedExact = Number(finalUsedPct.toFixed(2));
    finalNativeRemPct = Math.round(Math.max(0, 100 - finalUsedPct));
  }

  // Count how many in-cycle resets occurred within this natural cycle
  const natStartRef = Number.isFinite(naturalCycleStartMs) ? naturalCycleStartMs : effectiveStartMs;
  const natEndRef = Number.isFinite(effectiveResetsAtMs) ? effectiveResetsAtMs : effectiveStartMs + windowMs;
  const eventCountInNaturalCycle = (resetRecord?.events || []).filter(e => {
    const rMs = Date.parse(e.resetAt);
    return (
      e.mode === 'in_cycle' &&
      Number.isFinite(rMs) &&
      rMs >= natStartRef - 60_000 &&
      rMs <= natEndRef + 60_000
    );
  }).length;

  const lastEvent = resetRecord?.events?.length ? resetRecord.events.at(-1) : null;

  const resetInfo = {
    pool: poolKey,
    mode,
    source,
    resetAt: resetAtMs ? new Date(resetAtMs).toISOString() : null,
    naturalCycleStartAt: Number.isFinite(naturalCycleStartMs) ? new Date(naturalCycleStartMs).toISOString() : new Date(effectiveStartMs).toISOString(),
    naturalResetsAt: Number.isFinite(effectiveResetsAtMs) ? new Date(effectiveResetsAtMs).toISOString() : null,
    effectiveCycleStartAt: new Date(effectiveStartMs).toISOString(),
    hasActiveOverride,
    isManualOverride,
    usedOfficialSync: useOfficialPct,
    eventCountInNaturalCycle,
    note: resetNote,
    lastEvent: lastEvent
      ? {
          id: lastEvent.id,
          mode: lastEvent.mode,
          source: lastEvent.source,
          resetAt: lastEvent.resetAt,
          naturalResetsAt: lastEvent.naturalResetsAt,
          prevUsedPct: lastEvent.prevUsedPct,
          note: lastEvent.note
        }
      : null
  };

  return {
    cycle7dStartMs: effectiveStartMs,
    sevenDayResetsAtMs: effectiveResetsAtMs,
    sevenDayUsedPct: finalUsedPct,
    sevenDayUsedExact: finalUsedExact,
    sevenDayNativeRemPct: finalNativeRemPct,
    sevenDayBudgetUsd: budgetUsd,
    turns7d,
    stats7d,
    startGraceMs,
    quotaSourceLabel: finalSourceLabel,
    isOfficialPctActive: useOfficialPct,
    resetInfo
  };
}

// Reconcile any active overrides that have reached their naturalResetsAt boundary
function reconcileExpiredQuotaResets(nowMs, turnsByPool, settings, liveQuota) {
  const rs = loadQuotaResets();
  const history = loadQuotaHistory();
  let resetsDirty = false;
  let historyDirty = false;

  const planCatalog = activePricing.SUBSCRIPTION_PLANS || SUBSCRIPTION_PLANS;
  const defaultBudgets = {
    claude: (planCatalog.claude?.[settings.claudePlan || 'pro'] || planCatalog.claude.pro).sevenDayBudgetUsd,
    gpt: (planCatalog.gpt?.[settings.gptPlan || 'plus'] || planCatalog.gpt.plus).sevenDayBudgetUsd,
    'agy-gemini': (planCatalog.antigravity?.[settings.antigravityPlan || 'ultra5x'] || Object.values(planCatalog.antigravity)[0]).sevenDayBudgetUsd,
    'agy-tp': (planCatalog.antigravity?.[settings.antigravityPlan || 'ultra5x'] || Object.values(planCatalog.antigravity)[0]).thirdParty7dBudgetUsd || 31.1
  };

  for (const poolKey of WEEKLY_POOL_KEYS) {
    const pState = rs.pools[poolKey];
    const ov = pState?.activeOverride;
    if (!ov || !ov.naturalResetsAt) continue;

    const natEndMs = Date.parse(ov.naturalResetsAt);
    const startMs = Date.parse(ov.cycleStartAt || ov.resetAt);
    if (Number.isNaN(natEndMs) || nowMs < natEndMs) continue;

    // Override period has naturally expired! Archive that post-reset segment if it had turns or non-zero usage
    const turns = (turnsByPool[poolKey] || []).filter(t => t.ts >= startMs && t.ts < natEndMs);
    const cost = turns.reduce((s, t) => s + t.totalCostUsd, 0);
    const budget = Math.max(0.01, Number(defaultBudgets[poolKey] || 100));
    let finalUsedPct = Math.min(100, (cost / budget) * 100);

    // Check if liveQuota still holds a matching snapshot for that expired window
    const liveSnaps =
      poolKey === 'claude'
        ? extractPoolSnapshotsFromPayload('claude', liveQuota.claude)
        : poolKey === 'gpt'
        ? extractPoolSnapshotsFromPayload('gpt', liveQuota.gpt)
        : extractPoolSnapshotsFromPayload('antigravity', liveQuota.antigravity).filter(s => s.poolKey === poolKey);
    const matchingLive = liveSnaps.find(s => Math.abs(s.resetsAtMs - natEndMs) <= CLUSTER_TOLERANCE_MS_CONST);
    if (matchingLive && typeof matchingLive.usedPercentage === 'number' && (ov.source === 'auto' || matchingLive.usedPercentage < Number(ov.snapshotUsedPctAtReset ?? 100))) {
      finalUsedPct = Math.max(finalUsedPct, matchingLive.usedPercentage);
    }

    if (turns.length > 0 || finalUsedPct > 0) {
      const sealed = sealCycleSegmentToHistory(history[poolKey], {
        archiveStartMs: startMs,
        archiveEndMs: natEndMs,
        naturalResetsAtMs: natEndMs,
        usedPct: Number(finalUsedPct.toFixed(1)),
        mode: ov.mode === 'recalculate' ? 'recalculate' : 'in_cycle',
        resetSource: ov.source || 'manual',
        eventId: `${ov.eventId}_end`,
        sourceLabel: ov.mode === 'recalculate' ? '重算自然周期已结束' : '周内重置后段已结束',
        existingNatResetToReplaceMs: natEndMs
      });
      if (sealed.dirty) historyDirty = true;
    }

    if (ov.mode === 'recalculate') {
      pState.lastAnchorResetsAt = new Date(natEndMs).toISOString();
    }
    pState.activeOverride = null;
    resetsDirty = true;
  }

  if (historyDirty) saveQuotaHistory(history);
  if (resetsDirty) saveQuotaResets(rs);
  return { quotaResets: rs, quotaHistory: history };
}

function createTpsTracker(trackSamples = false) {
  return {
    timedTurns: 0,
    timedOutputTokens: 0,
    timedDurationMs: 0,
    peakTps: 0,
    thinkingTimedTurns: 0,
    thinkingTimedTokens: 0,
    thinkingTimedDurationMs: 0,
    samples: trackSamples ? [] : null
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
    if (tracker.samples) {
      const ts = turn._ts !== undefined ? turn._ts : turn.timestamp ? Date.parse(turn.timestamp) : 0;
      tracker.samples.push({
        ts: Number.isNaN(ts) ? 0 : ts,
        tps: turn.tps,
        out: turn.outputTokens
      });
    }
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
  if (includeTrend && tracker.samples) {
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
function computeClaudeQuota(allTurns, settings, liveQuotaEntry, officialHistory, quotaHistoryRecords = [], quotaResetRecord = null) {
  const nowMs = Date.now();
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const THIRTY_D_MS = 30 * 24 * 3600 * 1000;

  const sortedTurns = [];
  for (let i = 0; i < allTurns.length; i++) {
    const t = allTurns[i];
    if (t.ts === undefined) t.ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
    if (!Number.isNaN(t.ts)) sortedTurns.push(t);
  }
  sortedTurns.sort((a, b) => a.ts - b.ts);

  const planCatalog = (activePricing.SUBSCRIPTION_PLANS || SUBSCRIPTION_PLANS).claude;
  const selectedPlanKey = settings.claudePlan || 'pro';
  const plan = planCatalog[selectedPlanKey] || planCatalog.pro;

  let fiveHourBudgetUsd = settings.customClaude5hUsd || plan.fiveHourBudgetUsd;
  let calibrated7dBudgetUsd = plan.sevenDayBudgetUsd;

  const samples = officialHistory?.samples || [];
  let isOfficialLiveQuota = false;
  let quotaSourceLabel = '离散 5h/7d 周期测算 · 按 message.id 去重';

  let cycle5hStartMs = null;
  let fiveHourResetsAtMs = null;
  let fiveHourUsedPct = null;

  let baseCycle7dStartMs = null;
  let base7dResetsAtMs = null;
  let base7dUsedPct = null;
  let base7dAsOfMs = null;
  let base7dIsOfficial = false;
  let base7dStartGraceMs = 45 * 1000;

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
    baseCycle7dStartMs = candidate7dTurns[0]?.ts || raw7dAnchorMs;
    // If more than 7 days have passed since baseCycle7dStartMs without a new sample, roll forward by 7d steps
    while (nowMs >= baseCycle7dStartMs + SEVEN_D_MS) {
      baseCycle7dStartMs += SEVEN_D_MS;
    }
    base7dResetsAtMs = baseCycle7dStartMs + SEVEN_D_MS;

    const latestSample = samples.at(-1);
    if (latestSample.t >= baseCycle7dStartMs && typeof latestSample.u.sd === 'number') {
      const costAtSample7d = sortedTurns
        .filter(t => t.ts >= baseCycle7dStartMs && t.ts <= latestSample.t)
        .reduce((s, t) => s + t.totalCostUsd, 0);
      if (latestSample.u.sd >= 8 && costAtSample7d > 5) {
        calibrated7dBudgetUsd = Number((costAtSample7d / (latestSample.u.sd / 100)).toFixed(2));
      }
      const deltaCostAfter7d = sortedTurns
        .filter(t => t.ts > latestSample.t)
        .reduce((s, t) => s + t.totalCostUsd, 0);
      base7dUsedPct = Math.min(
        100,
        latestSample.u.sd + (deltaCostAfter7d / calibrated7dBudgetUsd) * 100
      );
      base7dAsOfMs = latestSample.t;
      base7dIsOfficial = true;
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
  let liveIsSameActiveCycle = false;
  if (liveQuotaEntry?.sevenDay) {
    const sdEntry = liveQuotaEntry.sevenDay;
    const reset7dMs = parseResetTimestampMs(sdEntry.resetsAt);
    if (!Number.isNaN(reset7dMs)) {
      let effReset7dMs = reset7dMs;
      while (nowMs >= effReset7dMs) {
        effReset7dMs += SEVEN_D_MS;
      }
      const winStartMs = sdEntry.windowStartedAt ? Date.parse(sdEntry.windowStartedAt) : NaN;
      base7dResetsAtMs = effReset7dMs;
      baseCycle7dStartMs =
        !Number.isNaN(winStartMs) && effReset7dMs === reset7dMs
          ? winStartMs
          : effReset7dMs - SEVEN_D_MS;
      liveIsSameActiveCycle = effReset7dMs === reset7dMs;
      base7dStartGraceMs = 0;
    } else {
      liveIsSameActiveCycle = true;
    }
    if (liveIsSameActiveCycle && typeof sdEntry.usedPercentage === 'number') {
      base7dUsedPct = sdEntry.usedPercentage;
      base7dAsOfMs = parseResetTimestampMs(sdEntry.asOf || liveQuotaEntry.updatedAt) || nowMs;
      base7dIsOfficial = true;
      isOfficialLiveQuota = true;
    } else if (!liveIsSameActiveCycle) {
      // Previous official live cycle expired; reset sample-derived stale 7d percentage unless samples cover the new cycle
      if (!base7dAsOfMs || base7dAsOfMs < baseCycle7dStartMs) {
        base7dUsedPct = null;
        base7dIsOfficial = false;
      }
    }
  }
  if (liveQuotaEntry?.source === 'claude_oauth_api' && isOfficialLiveQuota) {
    const syncTs = liveQuotaEntry.sevenDay?.asOf || liveQuotaEntry.updatedAt || new Date(nowMs).toISOString();
    quotaSourceLabel = `已直连 Claude 官方 OAuth 实时配额 (同步于 ${toLocalHMS(syncTs)} ${getTzLabel()}) · 周期已对齐`;
  } else if (liveQuotaEntry?.source === 'claude_oauth_api' && !liveIsSameActiveCycle && liveQuotaEntry?.sevenDay?.resetsAt) {
    const syncTs = liveQuotaEntry.sevenDay?.asOf || liveQuotaEntry.updatedAt || new Date(nowMs).toISOString();
    quotaSourceLabel = `已按 Claude OAuth 周期对齐 (上期同步于 ${toLocalHMS(syncTs)} ${getTzLabel()}) · 本期按消费估算`;
  } else if (isOfficialLiveQuota && (liveQuotaEntry?.fiveHour?.usedPercentage != null || liveQuotaEntry?.sevenDay?.usedPercentage != null)) {
    quotaSourceLabel = '已直连 Claude Code StatusLine 实时配额与重置周期';
  }

  // Detect any intra-cycle reset inside current natural week from Claude Desktop samples
  let inCycleSampleResetMs = null;
  if (samples.length > 1 && baseCycle7dStartMs && base7dResetsAtMs) {
    for (let i = 1; i < samples.length; i++) {
      const prevSd = samples[i - 1].u.sd;
      const currSd = samples[i].u.sd;
      const tMs = samples[i].t;
      if (
        tMs > baseCycle7dStartMs + 60_000 &&
        tMs < base7dResetsAtMs &&
        typeof prevSd === 'number' &&
        typeof currSd === 'number' &&
        ((prevSd >= 5 && currSd <= 1) || prevSd - currSd >= 15)
      ) {
        inCycleSampleResetMs = tMs;
      }
    }
  }

  // Step C: Fallback to discrete cycle windows if no official history
  if (!cycle5hStartMs) {
    const discrete5h = findDiscreteCycleWindow(sortedTurns, FIVE_H_MS, nowMs);
    cycle5hStartMs = discrete5h.cycleStartMs;
    fiveHourResetsAtMs = discrete5h.resetsAtMs;
  }
  if (!baseCycle7dStartMs) {
    const discrete7d = findDiscreteCycleWindow(sortedTurns, SEVEN_D_MS, nowMs);
    baseCycle7dStartMs = discrete7d.cycleStartMs;
    base7dResetsAtMs = discrete7d.resetsAtMs;
  }

  const turns5h = sortedTurns.filter(t => t.ts >= cycle5hStartMs);
  const turns30d = sortedTurns.filter(t => t.ts >= nowMs - THIRTY_D_MS);
  const stats5h = sumTurnMetrics(turns5h);
  const stats30d = sumTurnMetrics(turns30d);

  if (!settings.customClaude5hUsd && isOfficialLiveQuota && typeof fiveHourUsedPct === 'number' && fiveHourUsedPct >= 15 && stats5h.costUsd > 2) {
    fiveHourBudgetUsd = Number((stats5h.costUsd / (fiveHourUsedPct / 100)).toFixed(2));
  }
  if (fiveHourUsedPct === null) {
    fiveHourUsedPct = Math.min(100, (stats5h.costUsd / fiveHourBudgetUsd) * 100);
  }

  // Step D: Resolve active reset overrides (in_cycle vs recalculate) and compute 7d metrics
  const resolved7d = resolveWeeklyCycleWithResets({
    poolKey: 'claude',
    nowMs,
    windowMs: SEVEN_D_MS,
    baseCycleStartMs: baseCycle7dStartMs,
    baseResetsAtMs: base7dResetsAtMs,
    baseUsedPct: base7dUsedPct,
    baseAsOfMs: base7dAsOfMs,
    baseIsOfficial: base7dIsOfficial,
    baseSourceLabel: quotaSourceLabel,
    baseStartGraceMs: base7dStartGraceMs,
    resetRecord: quotaResetRecord,
    sortedTurns,
    defaultBudgetUsd: plan.sevenDayBudgetUsd,
    initialCalibratedBudgetUsd: calibrated7dBudgetUsd,
    minBudgetCost: 5,
    minBudgetPct: 8,
    inCycleSampleResetMs
  });

  const cycle7dStartMs = resolved7d.cycle7dStartMs;
  const sevenDayResetsAtMs = resolved7d.sevenDayResetsAtMs;
  const sevenDayUsedPct = resolved7d.sevenDayUsedPct;
  const sevenDayBudgetUsd = resolved7d.sevenDayBudgetUsd;
  const stats7d = resolved7d.stats7d;
  quotaSourceLabel = resolved7d.quotaSourceLabel || quotaSourceLabel;

  const roiMultiplier = plan.monthlyPriceUsd > 0 ? stats30d.costUsd / plan.monthlyPriceUsd : 0;

  const dailyBreakdown = buildWeeklyDailyBreakdown({
    sortedTurns,
    cycle7dStartMs,
    sevenDayResetsAtMs,
    sevenDayUsedPct,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    nowMs,
    startGraceMs: resolved7d.startGraceMs,
    resetInfo: resolved7d.resetInfo
  });

  // Reconstruct historical weekly cycles from quota_history.json + plan-usage-history.json + expired liveQuota
  const historyRecords = historyRecordsToOfficialPastCycles(quotaHistoryRecords, 'Claude OAuth 官方记录');
  if (liveQuotaEntry?.sevenDay?.resetsAt && typeof liveQuotaEntry.sevenDay.usedPercentage === 'number') {
    const lrMs = parseResetTimestampMs(liveQuotaEntry.sevenDay.resetsAt);
    if (!Number.isNaN(lrMs) && lrMs <= cycle7dStartMs + 15 * 60_000) {
      const lwStart = liveQuotaEntry.sevenDay.windowStartedAt ? Date.parse(liveQuotaEntry.sevenDay.windowStartedAt) : NaN;
      historyRecords.push({
        startMs: !Number.isNaN(lwStart) && lwStart < lrMs ? lwStart : lrMs - SEVEN_D_MS,
        endMs: lrMs,
        naturalResetsAtMs: lrMs,
        usedPct: liveQuotaEntry.sevenDay.usedPercentage,
        sourceLabel: 'Claude OAuth 官方记录',
        isResetArchive: false,
        resetMode: 'natural',
        resetSource: 'official'
      });
    }
  }

  const sampleSegments = [];
  if (samples.length > 0) {
    let curSeg = [];
    for (const s of samples) {
      if (typeof s?.u?.sd !== 'number') continue;
      if (curSeg.length > 0 && (s.u.sd < curSeg.at(-1).u.sd - 2 || (s.u.sd === 0 && curSeg.at(-1).u.sd > 0))) {
        sampleSegments.push(curSeg);
        curSeg = [];
      }
      curSeg.push(s);
    }
    if (curSeg.length > 0) sampleSegments.push(curSeg);
  }

  const knownLaterBoundaries = [
    ...historyRecords.map(h => h.startMs),
    cycle7dStartMs
  ].filter(v => Number.isFinite(v)).sort((a, b) => a - b);

  const claudeOfficialPastCycles = [...historyRecords];
  for (let i = 0; i < sampleSegments.length; i++) {
    const seg = sampleSegments[i];
    const nextSeg = sampleSegments[i + 1];
    const lastSample = seg.at(-1);
    let segEndMs = nextSeg ? nextSeg[0].t : knownLaterBoundaries.find(b => b > lastSample.t) || seg[0].t + SEVEN_D_MS;
    if (segEndMs > cycle7dStartMs) segEndMs = cycle7dStartMs;
    if (segEndMs <= seg[0].t + 60_000) continue;

    const segStartMs =
      seg[0].u.sd === 0
        ? seg[0].t
        : Math.max(sortedTurns[0]?.ts || segEndMs - SEVEN_D_MS, segEndMs - SEVEN_D_MS);
    const deltaCost = sortedTurns
      .filter(t => t.ts > lastSample.t && t.ts < segEndMs)
      .reduce((s, t) => s + t.totalCostUsd, 0);
    const usedPct = Math.min(100, lastSample.u.sd + (deltaCost / Math.max(1, sevenDayBudgetUsd)) * 100);

    const isSegInCycle = nextSeg && segEndMs - segStartMs < SEVEN_D_MS - 3 * 3600 * 1000;
    claudeOfficialPastCycles.push({
      startMs: segStartMs,
      endMs: segEndMs,
      naturalResetsAtMs: isSegInCycle ? sevenDayResetsAtMs || segEndMs : segEndMs,
      usedPct: Number(usedPct.toFixed(1)),
      sourceLabel: 'Claude Desktop 官方配额记录',
      isResetArchive: isSegInCycle,
      resetMode: isSegInCycle ? 'in_cycle' : 'natural',
      resetSource: 'official'
    });
  }

  const weeklyHistory = buildWeeklyHistoryCycles({
    sortedTurns,
    currentCycleStartMs: cycle7dStartMs,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    officialPastCycles: claudeOfficialPastCycles,
    nowMs,
    currentResetMode: resolved7d.resetInfo.mode
  });

  const claude5hSource =
    liveQuotaEntry?.fiveHour?.resetsAt && parseResetTimestampMs(liveQuotaEntry.fiveHour.resetsAt) > nowMs
      ? 'official_live'
      : samples.length > 0 && isOfficialLiveQuota
      ? 'official_cached'
      : 'estimated';
  const claude7dSource = resolved7d.isOfficialPctActive
    ? 'official_live'
    : liveQuotaEntry?.sevenDay?.resetsAt || samples.length > 0
    ? 'official_cached'
    : 'estimated';
  const claudeSyncedAt =
    liveQuotaEntry?.syncedAt ||
    liveQuotaEntry?.sevenDay?.asOf ||
    liveQuotaEntry?.updatedAt ||
    (samples.length > 0 ? new Date(samples.at(-1).t).toISOString() : null);

  return {
    platform: 'claude',
    planId: plan.id,
    planName: plan.name,
    monthlyPriceUsd: plan.monthlyPriceUsd,
    fiveHourBudgetUsd: Number(fiveHourBudgetUsd.toFixed(2)),
    sevenDayBudgetUsd: Number(sevenDayBudgetUsd.toFixed(2)),
    isOfficialLiveQuota: isOfficialLiveQuota || resolved7d.isOfficialPctActive,
    quotaSourceLabel,
    accountEmail: officialHistory?.accountInfo?.email || null,
    syncDiagnostic: quotaSyncDiagnostics.claude,
    fiveHour: {
      ...stats5h,
      usedPercentage: Number(fiveHourUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - fiveHourUsedPct).toFixed(1)),
      cycleStartAt: new Date(cycle5hStartMs).toISOString(),
      resetsAt: fiveHourResetsAtMs ? new Date(fiveHourResetsAtMs).toISOString() : null,
      resetSource: claude5hSource,
      resetSourceLabel:
        claude5hSource === 'official_live'
          ? 'Claude 官方 OAuth 实时直连'
          : claude5hSource === 'official_cached'
          ? 'Claude Desktop 官方历史对齐'
          : '本地 5H 离散窗口推算',
      syncedAt: claudeSyncedAt
    },
    sevenDay: {
      ...stats7d,
      usedPercentage: Number(sevenDayUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - sevenDayUsedPct).toFixed(1)),
      cycleStartAt: new Date(cycle7dStartMs).toISOString(),
      resetsAt: sevenDayResetsAtMs ? new Date(sevenDayResetsAtMs).toISOString() : null,
      resetSource: claude7dSource,
      resetSourceLabel:
        claude7dSource === 'official_live'
          ? 'Claude 官方实时直连'
          : claude7dSource === 'official_cached'
          ? 'Claude 官方周期顺延对齐'
          : '本地 7D 离散周期推算',
      syncedAt: claudeSyncedAt,
      resetInfo: resolved7d.resetInfo,
      dailyBreakdown,
      weeklyHistory
    },
    thirtyDay: {
      ...stats30d,
      roiMultiplier: Number(roiMultiplier.toFixed(2)),
      roiPercentage: Math.round(roiMultiplier * 100)
    }
  };
}

function computeAntigravityQuota(allTurns, settings, liveQuotaEntry, quotaHistoryMap = {}, quotaResetsMap = {}) {
  const nowMs = Date.now();
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const THIRTY_D_MS = 30 * 24 * 3600 * 1000;
  const START_GRACE_MS = 45 * 1000; // Include the triggering turn whose created_at precedes server stream-end resetTime by a few seconds

  const sortedTurns = [];
  for (let i = 0; i < allTurns.length; i++) {
    const t = allTurns[i];
    if (t.ts === undefined) t.ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
    if (!Number.isNaN(t.ts)) sortedTurns.push(t);
  }
  sortedTurns.sort((a, b) => a.ts - b.ts);

  // Exclude external API / Vertex AI / local gateway calls from Antigravity subscription quota pools
  const externalTurns = sortedTurns.filter(t => Boolean(t.isExternalApi));
  const subscriptionTurns = sortedTurns.filter(t => !t.isExternalApi);

  // Separate subscription turns into Gemini native pool vs Third-Party (Claude & GPT) pool
  const isThirdPartyModel = m => /claude|gpt|opus|sonnet|haiku|fable/i.test(String(m || ''));
  const geminiTurns = subscriptionTurns.filter(t => !isThirdPartyModel(t.model));
  const thirdPartyTurns = subscriptionTurns.filter(t => isThirdPartyModel(t.model));

  const planCatalog = (activePricing.SUBSCRIPTION_PLANS || SUBSCRIPTION_PLANS).antigravity;
  let selectedPlanKey = settings.antigravityPlan || 'ultra5x';
  if (
    liveQuotaEntry?.userTierId === 'g1-ultra-lite-tier' &&
    selectedPlanKey === 'ultra'
  ) {
    selectedPlanKey = 'ultra5x';
  }
  const plan = planCatalog[selectedPlanKey] || planCatalog.ultra5x || Object.values(planCatalog)[0];

  let fiveHourBudgetUsd = settings.customAgy5hUsd || plan.fiveHourBudgetUsd;
  let thirdParty5hBudgetUsd = plan.thirdParty5hBudgetUsd || 15.6;

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

  let baseGem7dStartMs = null;
  let baseGem7dResetsAtMs = null;
  let baseGem7dUsedPct = null;
  let baseGem7dUsedExact = null;
  let baseGem7dNativeRemPct = null;
  let baseGem7dIsOfficial = false;
  const gemAsOfMs = liveQuotaEntry?.updatedAt ? Date.parse(liveQuotaEntry.updatedAt) : null;

  const geminiWeeklyBucket = liveQuotaEntry?.pools?.geminiWeekly;
  if (geminiWeeklyBucket?.resetsAt) {
    const reset7dMs = Date.parse(geminiWeeklyBucket.resetsAt);
    if (!Number.isNaN(reset7dMs) && reset7dMs > nowMs) {
      baseGem7dResetsAtMs = reset7dMs;
      baseGem7dStartMs = reset7dMs - SEVEN_D_MS;
      if (typeof geminiWeeklyBucket.usedPercentage === 'number') {
        baseGem7dUsedPct = geminiWeeklyBucket.usedPercentage;
        baseGem7dUsedExact =
          geminiWeeklyBucket.usedPercentageExact ?? geminiWeeklyBucket.usedPercentage;
        baseGem7dNativeRemPct =
          geminiWeeklyBucket.nativeRemainingPct ?? Math.round(100 - baseGem7dUsedPct);
        baseGem7dIsOfficial = true;
      }
    }
  }
  if (!baseGem7dStartMs) {
    const discrete7d = findDiscreteCycleWindow(geminiTurns, SEVEN_D_MS, nowMs);
    baseGem7dStartMs = discrete7d.cycleStartMs;
    baseGem7dResetsAtMs = discrete7d.resetsAtMs;
  }

  const turns5h = geminiTurns.filter(t => t.ts >= cycle5hStartMs - START_GRACE_MS);
  const turns30d = subscriptionTurns.filter(t => t.ts >= nowMs - THIRTY_D_MS);
  const stats5h = sumTurnMetrics(turns5h);
  const stats30d = sumTurnMetrics(turns30d);

  if (
    !settings.customAgy5hUsd &&
    isOfficialLiveQuota &&
    fiveHourUsedExact >= 3 &&
    stats5h.costUsd >= 0.5
  ) {
    fiveHourBudgetUsd = Number((stats5h.costUsd / (fiveHourUsedExact / 100)).toFixed(2));
  }
  if (fiveHourUsedPct === null) {
    fiveHourUsedPct = Math.min(100, (stats5h.costUsd / fiveHourBudgetUsd) * 100);
    fiveHourNativeRemPct = Math.round(Math.max(0, 100 - fiveHourUsedPct));
  }

  const gemResolved = resolveWeeklyCycleWithResets({
    poolKey: 'agy-gemini',
    nowMs,
    windowMs: SEVEN_D_MS,
    baseCycleStartMs: baseGem7dStartMs,
    baseResetsAtMs: baseGem7dResetsAtMs,
    baseUsedPct: baseGem7dUsedPct,
    baseUsedExact: baseGem7dUsedExact,
    baseNativeRemPct: baseGem7dNativeRemPct,
    baseAsOfMs: gemAsOfMs,
    baseIsOfficial: baseGem7dIsOfficial,
    baseSourceLabel: quotaSourceLabel,
    baseStartGraceMs: START_GRACE_MS,
    resetRecord: quotaResetsMap['agy-gemini'] || null,
    sortedTurns: geminiTurns,
    defaultBudgetUsd: plan.sevenDayBudgetUsd,
    minBudgetCost: 0.5,
    minBudgetPct: 2
  });

  const cycle7dStartMs = gemResolved.cycle7dStartMs;
  const sevenDayResetsAtMs = gemResolved.sevenDayResetsAtMs;
  const sevenDayUsedPct = gemResolved.sevenDayUsedPct;
  const sevenDayNativeRemPct = gemResolved.sevenDayNativeRemPct;
  const sevenDayBudgetUsd = gemResolved.sevenDayBudgetUsd;
  const stats7d = gemResolved.stats7d;
  if (gemResolved.quotaSourceLabel) quotaSourceLabel = gemResolved.quotaSourceLabel;

  const extStats5h = sumTurnMetrics(externalTurns.filter(t => t.ts >= cycle5hStartMs - START_GRACE_MS));
  const extStats7d = sumTurnMetrics(externalTurns.filter(t => t.ts >= cycle7dStartMs - gemResolved.startGraceMs));
  const extStats30d = sumTurnMetrics(externalTurns.filter(t => t.ts >= nowMs - THIRTY_D_MS));

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

  let baseTp7dStartMs = null;
  let baseTp7dResetsAtMs = null;
  let baseTp7dUsedPct = null;
  let baseTp7dUsedExact = null;
  let baseTp7dNativeRemPct = null;
  let baseTp7dIsOfficial = false;

  const tpWeeklyBucket = liveQuotaEntry?.pools?.claudeWeekly;
  if (tpWeeklyBucket?.resetsAt) {
    const reset7dMs = Date.parse(tpWeeklyBucket.resetsAt);
    if (!Number.isNaN(reset7dMs) && reset7dMs > nowMs) {
      baseTp7dResetsAtMs = reset7dMs;
      baseTp7dStartMs = reset7dMs - SEVEN_D_MS;
      if (typeof tpWeeklyBucket.usedPercentage === 'number') {
        baseTp7dUsedPct = tpWeeklyBucket.usedPercentage;
        baseTp7dUsedExact = tpWeeklyBucket.usedPercentageExact ?? tpWeeklyBucket.usedPercentage;
        baseTp7dNativeRemPct = tpWeeklyBucket.nativeRemainingPct ?? Math.round(100 - baseTp7dUsedPct);
        baseTp7dIsOfficial = true;
      }
    }
  }
  if (!baseTp7dStartMs) {
    const discreteTp7d = findDiscreteCycleWindow(thirdPartyTurns, SEVEN_D_MS, nowMs);
    baseTp7dStartMs = discreteTp7d.cycleStartMs;
    baseTp7dResetsAtMs = discreteTp7d.resetsAtMs;
  }

  const tpTurns5h = thirdPartyTurns.filter(t => t.ts >= tp5hStartMs - START_GRACE_MS);
  const tpStats5h = sumTurnMetrics(tpTurns5h);

  if (tp5hUsedExact >= 0.1 && tpStats5h.costUsd >= 0.01) {
    thirdParty5hBudgetUsd = Number((tpStats5h.costUsd / (tp5hUsedExact / 100)).toFixed(2));
  }
  if (tp5hUsedPct === null) {
    tp5hUsedPct = Math.min(100, (tpStats5h.costUsd / thirdParty5hBudgetUsd) * 100);
    tp5hNativeRemPct = Math.round(Math.max(0, 100 - tp5hUsedPct));
  }

  const tpResolved = resolveWeeklyCycleWithResets({
    poolKey: 'agy-tp',
    nowMs,
    windowMs: SEVEN_D_MS,
    baseCycleStartMs: baseTp7dStartMs,
    baseResetsAtMs: baseTp7dResetsAtMs,
    baseUsedPct: baseTp7dUsedPct,
    baseUsedExact: baseTp7dUsedExact,
    baseNativeRemPct: baseTp7dNativeRemPct,
    baseAsOfMs: gemAsOfMs,
    baseIsOfficial: baseTp7dIsOfficial,
    baseSourceLabel: isOfficialLiveQuota ? 'Antigravity 第三方官方配额直连' : '离散 7d 周期测算',
    baseStartGraceMs: START_GRACE_MS,
    resetRecord: quotaResetsMap['agy-tp'] || null,
    sortedTurns: thirdPartyTurns,
    defaultBudgetUsd: plan.thirdParty7dBudgetUsd || 31.1,
    minBudgetCost: 0.01,
    minBudgetPct: 0.05
  });

  const tp7dStartMs = tpResolved.cycle7dStartMs;
  const tp7dResetsAtMs = tpResolved.sevenDayResetsAtMs;
  const tp7dUsedPct = tpResolved.sevenDayUsedPct;
  const tp7dNativeRemPct = tpResolved.sevenDayNativeRemPct;
  const thirdParty7dBudgetUsd = tpResolved.sevenDayBudgetUsd;
  const tpStats7d = tpResolved.stats7d;

  const roiMultiplier = plan.monthlyPriceUsd > 0 ? stats30d.costUsd / plan.monthlyPriceUsd : 0;

  const geminiDailyBreakdown = buildWeeklyDailyBreakdown({
    sortedTurns: geminiTurns,
    cycle7dStartMs,
    sevenDayResetsAtMs,
    sevenDayUsedPct,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    nowMs,
    startGraceMs: gemResolved.startGraceMs,
    resetInfo: gemResolved.resetInfo
  });

  const tpDailyBreakdown = buildWeeklyDailyBreakdown({
    sortedTurns: thirdPartyTurns,
    cycle7dStartMs: tp7dStartMs,
    sevenDayResetsAtMs: tp7dResetsAtMs,
    sevenDayUsedPct: tp7dUsedPct,
    sevenDayBudgetUsd: thirdParty7dBudgetUsd,
    fiveHourBudgetUsd: thirdParty5hBudgetUsd,
    nowMs,
    startGraceMs: tpResolved.startGraceMs,
    resetInfo: tpResolved.resetInfo
  });

  const geminiOfficialPastCycles = historyRecordsToOfficialPastCycles(
    quotaHistoryMap['agy-gemini'] || [],
    'Antigravity 官方配额记录'
  );
  if (geminiWeeklyBucket?.resetsAt && typeof (geminiWeeklyBucket.usedPercentageExact ?? geminiWeeklyBucket.usedPercentage) === 'number') {
    const grMs = parseResetTimestampMs(geminiWeeklyBucket.resetsAt);
    if (!Number.isNaN(grMs) && grMs <= cycle7dStartMs + 15 * 60_000) {
      geminiOfficialPastCycles.push({
        startMs: grMs - SEVEN_D_MS,
        endMs: grMs,
        naturalResetsAtMs: grMs,
        usedPct: Number(geminiWeeklyBucket.usedPercentageExact ?? geminiWeeklyBucket.usedPercentage),
        sourceLabel: 'Antigravity 官方配额记录',
        isResetArchive: false,
        resetMode: 'natural',
        resetSource: 'official'
      });
    }
  }

  const tpOfficialPastCycles = historyRecordsToOfficialPastCycles(
    quotaHistoryMap['agy-tp'] || [],
    'Antigravity 第三方官方配额记录'
  );
  if (tpWeeklyBucket?.resetsAt && typeof (tpWeeklyBucket.usedPercentageExact ?? tpWeeklyBucket.usedPercentage) === 'number') {
    const trMs = parseResetTimestampMs(tpWeeklyBucket.resetsAt);
    if (!Number.isNaN(trMs) && trMs <= tp7dStartMs + 15 * 60_000) {
      tpOfficialPastCycles.push({
        startMs: trMs - SEVEN_D_MS,
        endMs: trMs,
        naturalResetsAtMs: trMs,
        usedPct: Number(tpWeeklyBucket.usedPercentageExact ?? tpWeeklyBucket.usedPercentage),
        sourceLabel: 'Antigravity 第三方官方配额记录',
        isResetArchive: false,
        resetMode: 'natural',
        resetSource: 'official'
      });
    }
  }

  const geminiWeeklyHistory = buildWeeklyHistoryCycles({
    sortedTurns: geminiTurns,
    currentCycleStartMs: cycle7dStartMs,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    officialPastCycles: geminiOfficialPastCycles,
    nowMs,
    currentResetMode: gemResolved.resetInfo.mode
  });

  const tpWeeklyHistory = buildWeeklyHistoryCycles({
    sortedTurns: thirdPartyTurns,
    currentCycleStartMs: tp7dStartMs,
    sevenDayBudgetUsd: thirdParty7dBudgetUsd,
    fiveHourBudgetUsd: thirdParty5hBudgetUsd,
    officialPastCycles: tpOfficialPastCycles,
    nowMs,
    currentResetMode: tpResolved.resetInfo.mode
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
      resetsAt: fiveHourResetsAtMs ? new Date(fiveHourResetsAtMs).toISOString() : null,
      resetSource: isOfficialLiveQuota ? 'official_live' : 'estimated',
      resetSourceLabel: isOfficialLiveQuota
        ? `Antigravity LanguageServer 实时直连${liveQuotaEntry?.lsVersion ? ` (v${liveQuotaEntry.lsVersion})` : ''}`
        : '本地 5H 离散窗口推算',
      syncedAt: liveQuotaEntry?.syncedAt || liveQuotaEntry?.updatedAt || null,
      officialDescription: gemini5hBucket?.description || ''
    },
    sevenDay: {
      ...stats7d,
      usedPercentage: Number(sevenDayUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - sevenDayUsedPct).toFixed(1)),
      nativeRemainingPct: sevenDayNativeRemPct,
      cycleStartAt: new Date(cycle7dStartMs).toISOString(),
      resetsAt: sevenDayResetsAtMs ? new Date(sevenDayResetsAtMs).toISOString() : null,
      resetSource: gemResolved.isOfficialPctActive ? 'official_live' : baseGem7dIsOfficial ? 'official_cached' : 'estimated',
      resetSourceLabel: gemResolved.isOfficialPctActive
        ? `Antigravity LanguageServer 实时直连${liveQuotaEntry?.lsVersion ? ` (v${liveQuotaEntry.lsVersion})` : ''}`
        : '本地 7D 周期推算',
      syncedAt: liveQuotaEntry?.syncedAt || liveQuotaEntry?.updatedAt || null,
      officialDescription: geminiWeeklyBucket?.description || '',
      resetInfo: gemResolved.resetInfo,
      dailyBreakdown: geminiDailyBreakdown,
      weeklyHistory: geminiWeeklyHistory
    },
    syncDiagnostic: quotaSyncDiagnostics.antigravity,
    thirdParty: {
      groupName: 'Claude and GPT models',
      modelsLabel: 'Claude Opus 5.5 · Claude Sonnet 5.5 · GPT-OSS 120B',
      fiveHourBudgetUsd: Number(thirdParty5hBudgetUsd.toFixed(2)),
      sevenDayBudgetUsd: Number(thirdParty7dBudgetUsd.toFixed(2)),
      quotaSourceLabel: tpResolved.quotaSourceLabel,
      fiveHour: {
        ...tpStats5h,
        usedPercentage: Number(tp5hUsedPct.toFixed(1)),
        remainingPercentage: Number(Math.max(0, 100 - tp5hUsedPct).toFixed(1)),
        nativeRemainingPct: tp5hNativeRemPct,
        cycleStartAt: new Date(tp5hStartMs).toISOString(),
        resetsAt: tp5hResetsAtMs ? new Date(tp5hResetsAtMs).toISOString() : null,
        resetSource: tp5hBucket?.resetsAt && Date.parse(tp5hBucket.resetsAt) > nowMs ? 'official_live' : 'estimated',
        resetSourceLabel:
          tp5hBucket?.resetsAt && Date.parse(tp5hBucket.resetsAt) > nowMs
            ? 'Antigravity 第三方官方池实时直连'
            : '本地 5H 离散窗口推算',
        syncedAt: liveQuotaEntry?.syncedAt || liveQuotaEntry?.updatedAt || null,
        officialDescription: tp5hBucket?.description || ''
      },
      sevenDay: {
        ...tpStats7d,
        usedPercentage: Number(tp7dUsedPct.toFixed(1)),
        remainingPercentage: Number(Math.max(0, 100 - tp7dUsedPct).toFixed(1)),
        nativeRemainingPct: tp7dNativeRemPct,
        cycleStartAt: new Date(tp7dStartMs).toISOString(),
        resetsAt: tp7dResetsAtMs ? new Date(tp7dResetsAtMs).toISOString() : null,
        resetSource: tpResolved.isOfficialPctActive ? 'official_live' : baseTp7dIsOfficial ? 'official_cached' : 'estimated',
        resetSourceLabel: tpResolved.isOfficialPctActive
          ? 'Antigravity 第三方官方池实时直连'
          : '本地 7D 周期推算',
        syncedAt: liveQuotaEntry?.syncedAt || liveQuotaEntry?.updatedAt || null,
        officialDescription: tpWeeklyBucket?.description || '',
        resetInfo: tpResolved.resetInfo,
        dailyBreakdown: tpDailyBreakdown,
        weeklyHistory: tpWeeklyHistory
      }
    },
    thirtyDay: {
      ...stats30d,
      roiMultiplier: Number(roiMultiplier.toFixed(2)),
      roiPercentage: Math.round(roiMultiplier * 100)
    },
    externalApi: {
      fiveHour: extStats5h,
      sevenDay: extStats7d,
      thirtyDay: extStats30d
    }
  };
}

function computeGptQuota(allTurns, settings, liveQuotaEntry, codexAuthInfo, latestRolloutRateLimits = null, gptHistoryInputs = {}) {
  const nowMs = Date.now();
  const FIVE_H_MS = 5 * 3600 * 1000;
  const SEVEN_D_MS = 7 * 24 * 3600 * 1000;
  const THIRTY_D_MS = 30 * 24 * 3600 * 1000;

  const sortedTurns = [];
  for (let i = 0; i < allTurns.length; i++) {
    const t = allTurns[i];
    if (t.ts === undefined) t.ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
    if (!Number.isNaN(t.ts)) sortedTurns.push(t);
  }
  sortedTurns.sort((a, b) => a.ts - b.ts);

  const planCatalog = (activePricing.SUBSCRIPTION_PLANS || SUBSCRIPTION_PLANS).gpt;
  const autoPlanKey =
    codexAuthInfo?.planType && planCatalog[codexAuthInfo.planType]
      ? codexAuthInfo.planType
      : null;
  const selectedPlanKey = settings.gptPlan || autoPlanKey || 'plus';
  const plan = planCatalog[selectedPlanKey] || planCatalog.plus;

  let fiveHourBudgetUsd = settings.customGpt5hUsd || plan.fiveHourBudgetUsd;

  let isOfficialLiveQuota = false;
  let quotaSourceLabel = codexAuthInfo?.email
    ? `已识别 ChatGPT ${(codexAuthInfo.planType || plan.id).toUpperCase()} 账号 (${codexAuthInfo.email}) · 5h/7d 周期测算`
    : '离散 5h/7d 周期测算 · Codex 本地日志';

  let cycle5hStartMs = null;
  let fiveHourResetsAtMs = null;
  let fiveHourUsedPct = null;

  let base7dStartMs = null;
  let base7dResetsAtMs = null;
  let base7dUsedPct = null;
  let base7dAsOfMs = null;
  let base7dIsOfficial = false;
  let base7dWindowMs = SEVEN_D_MS;

  const applyActiveWindow = (usedPct, resetsAtVal, windowMs) => {
    const resetMs = parseResetTimestampMs(resetsAtVal);
    if (Number.isNaN(resetMs) || resetMs <= nowMs) return null;
    return {
      resetsAtMs: resetMs,
      cycleStartMs: resetMs - windowMs,
      usedPct: typeof usedPct === 'number' ? Number(usedPct) : null
    };
  };

  // Step A: Use rollout rate_limits if present & still active
  if (latestRolloutRateLimits) {
    const primary = latestRolloutRateLimits.primary;
    const secondary = latestRolloutRateLimits.secondary;
    const w5h = primary
      ? applyActiveWindow(
          primary.used_percent,
          primary.resets_at,
          primary.window_minutes ? Number(primary.window_minutes) * 60_000 : FIVE_H_MS
        )
      : null;
    if (w5h && w5h.usedPct !== null) {
      fiveHourResetsAtMs = w5h.resetsAtMs;
      cycle5hStartMs = w5h.cycleStartMs;
      fiveHourUsedPct = w5h.usedPct;
      isOfficialLiveQuota = true;
      quotaSourceLabel = '已直连 Codex 官方实时配额与重置周期';
    }
    const secWinMs = secondary?.window_minutes ? Number(secondary.window_minutes) * 60_000 : SEVEN_D_MS;
    const w7d = secondary
      ? applyActiveWindow(secondary.used_percent, secondary.resets_at, secWinMs)
      : null;
    if (w7d && w7d.usedPct !== null) {
      base7dResetsAtMs = w7d.resetsAtMs;
      base7dStartMs = w7d.cycleStartMs;
      base7dUsedPct = w7d.usedPct;
      base7dWindowMs = secWinMs;
      base7dAsOfMs = secondary._ts ? Date.parse(secondary._ts) : nowMs;
      base7dIsOfficial = true;
      isOfficialLiveQuota = true;
    }
  }

  // Step B: Override with live_quota.json (`gpt`) from official Codex API or Hook if active & fresher
  const isWhamApi = liveQuotaEntry?.source === 'codex_wham_api';
  const liveUpdatedAt = liveQuotaEntry?.updatedAt || '';
  const live5h = liveQuotaEntry?.fiveHour
    ? applyActiveWindow(
        liveQuotaEntry.fiveHour.usedPercentage,
        liveQuotaEntry.fiveHour.resetsAt,
        liveQuotaEntry.fiveHour.windowSeconds
          ? Number(liveQuotaEntry.fiveHour.windowSeconds) * 1000
          : FIVE_H_MS
      )
    : null;
  if (live5h && (isWhamApi || fiveHourUsedPct === null || liveUpdatedAt >= (latestRolloutRateLimits?.primary?._ts || ''))) {
    fiveHourResetsAtMs = live5h.resetsAtMs;
    cycle5hStartMs = live5h.cycleStartMs;
    if (live5h.usedPct !== null) {
      fiveHourUsedPct = live5h.usedPct;
      isOfficialLiveQuota = true;
    }
  } else if (isWhamApi && !live5h && liveQuotaEntry.allowed === true && liveUpdatedAt > (latestRolloutRateLimits?.primary?._ts || '')) {
    fiveHourResetsAtMs = null;
    cycle5hStartMs = null;
    fiveHourUsedPct = 0;
    isOfficialLiveQuota = true;
  }

  const live7dWinMs = liveQuotaEntry?.sevenDay?.windowSeconds
    ? Number(liveQuotaEntry.sevenDay.windowSeconds) * 1000
    : SEVEN_D_MS;
  const live7d = liveQuotaEntry?.sevenDay
    ? applyActiveWindow(liveQuotaEntry.sevenDay.usedPercentage, liveQuotaEntry.sevenDay.resetsAt, live7dWinMs)
    : null;
  if (live7d && (isWhamApi || base7dUsedPct === null || liveUpdatedAt >= (latestRolloutRateLimits?.secondary?._ts || ''))) {
    base7dResetsAtMs = live7d.resetsAtMs;
    base7dStartMs = live7d.cycleStartMs;
    base7dWindowMs = live7dWinMs;
    if (live7d.usedPct !== null) {
      base7dUsedPct = live7d.usedPct;
      base7dAsOfMs = parseResetTimestampMs(liveQuotaEntry.sevenDay?.asOf || liveUpdatedAt) || nowMs;
      base7dIsOfficial = true;
      isOfficialLiveQuota = true;
    }
  } else if (!live7d && !base7dResetsAtMs && liveQuotaEntry?.sevenDay?.resetsAt) {
    // Expired official natural reset time: keep natural weekly cadence aligned by stepping forward
    const rawRMs = parseResetTimestampMs(liveQuotaEntry.sevenDay.resetsAt);
    if (!Number.isNaN(rawRMs)) {
      let stepped = rawRMs;
      while (nowMs >= stepped) stepped += live7dWinMs;
      base7dResetsAtMs = stepped;
      base7dStartMs = stepped - live7dWinMs;
      base7dWindowMs = live7dWinMs;
    }
  }

  if (isWhamApi && (live5h || live7d)) {
    const syncTs = liveQuotaEntry.sevenDay?.asOf || liveQuotaEntry.updatedAt || new Date(nowMs).toISOString();
    quotaSourceLabel = `已直连 Codex 官方实时配额 (同步于 ${toLocalHMS(syncTs)} ${getTzLabel()}) · 周期已对齐`;
  } else if (!isWhamApi && (live5h || live7d)) {
    quotaSourceLabel = '已直连 Codex Hook 实时配额与重置周期';
  }

  // Step C: Fallback to discrete 5h / 7d cycle windows
  if (!cycle5hStartMs) {
    const discrete5h = findDiscreteCycleWindow(sortedTurns, FIVE_H_MS, nowMs);
    cycle5hStartMs = discrete5h.cycleStartMs;
    fiveHourResetsAtMs = discrete5h.resetsAtMs;
  }
  if (!base7dStartMs) {
    const discrete7d = findDiscreteCycleWindow(sortedTurns, base7dWindowMs, nowMs);
    base7dStartMs = discrete7d.cycleStartMs;
    base7dResetsAtMs = discrete7d.resetsAtMs;
  }

  const START_GRACE_MS = 45 * 1000;
  const turns5h = sortedTurns.filter(t => t.ts >= cycle5hStartMs - START_GRACE_MS);
  const turns30d = sortedTurns.filter(t => t.ts >= nowMs - THIRTY_D_MS);
  const stats5h = sumTurnMetrics(turns5h);
  const stats30d = sumTurnMetrics(turns30d);

  if (
    !settings.customGpt5hUsd &&
    isOfficialLiveQuota &&
    typeof fiveHourUsedPct === 'number' &&
    fiveHourUsedPct >= 10 &&
    stats5h.costUsd >= 1
  ) {
    fiveHourBudgetUsd = Number((stats5h.costUsd / (fiveHourUsedPct / 100)).toFixed(2));
  }
  if (fiveHourUsedPct === null) {
    fiveHourUsedPct = Math.min(100, (stats5h.costUsd / fiveHourBudgetUsd) * 100);
  }

  // Step D: Resolve active reset overrides (in_cycle vs recalculate) and compute 7d metrics
  const gptResolved = resolveWeeklyCycleWithResets({
    poolKey: 'gpt',
    nowMs,
    windowMs: base7dWindowMs,
    baseCycleStartMs: base7dStartMs,
    baseResetsAtMs: base7dResetsAtMs,
    baseUsedPct: base7dUsedPct,
    baseAsOfMs: base7dAsOfMs,
    baseIsOfficial: base7dIsOfficial,
    baseSourceLabel: quotaSourceLabel,
    baseStartGraceMs: START_GRACE_MS,
    resetRecord: gptHistoryInputs.quotaResetRecord || null,
    sortedTurns,
    defaultBudgetUsd: plan.sevenDayBudgetUsd,
    minBudgetCost: 2,
    minBudgetPct: 5
  });

  const cycle7dStartMs = gptResolved.cycle7dStartMs;
  const sevenDayResetsAtMs = gptResolved.sevenDayResetsAtMs;
  const sevenDayUsedPct = gptResolved.sevenDayUsedPct;
  const sevenDayBudgetUsd = gptResolved.sevenDayBudgetUsd;
  const stats7d = gptResolved.stats7d;
  quotaSourceLabel = gptResolved.quotaSourceLabel || quotaSourceLabel;

  const roiMultiplier = plan.monthlyPriceUsd > 0 ? stats30d.costUsd / plan.monthlyPriceUsd : 0;

  const dailyBreakdown = buildWeeklyDailyBreakdown({
    sortedTurns,
    cycle7dStartMs,
    sevenDayResetsAtMs,
    sevenDayUsedPct,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    nowMs,
    startGraceMs: gptResolved.startGraceMs,
    resetInfo: gptResolved.resetInfo
  });

  const gptOfficialPastCycles = historyRecordsToOfficialPastCycles(
    gptHistoryInputs.quotaHistoryRecords || [],
    'Codex OAuth 官方记录'
  );
  if (liveQuotaEntry?.sevenDay?.resetsAt && typeof liveQuotaEntry.sevenDay.usedPercentage === 'number') {
    const grMs = parseResetTimestampMs(liveQuotaEntry.sevenDay.resetsAt);
    if (!Number.isNaN(grMs) && grMs <= cycle7dStartMs + 15 * 60_000) {
      const winMs = liveQuotaEntry.sevenDay.windowSeconds
        ? Number(liveQuotaEntry.sevenDay.windowSeconds) * 1000
        : SEVEN_D_MS;
      gptOfficialPastCycles.push({
        startMs: grMs - winMs,
        endMs: grMs,
        naturalResetsAtMs: grMs,
        usedPct: Number(liveQuotaEntry.sevenDay.usedPercentage),
        sourceLabel: 'Codex OAuth 官方记录',
        isResetArchive: false,
        resetMode: 'natural',
        resetSource: 'official'
      });
    }
  }
  for (const sec of gptHistoryInputs.rolloutSecondaries || []) {
    if (!sec || typeof sec.used_percent !== 'number' || !sec.resets_at) continue;
    const endMs = parseResetTimestampMs(sec.resets_at);
    if (Number.isNaN(endMs)) continue;
    if (endMs <= cycle7dStartMs + 15 * 60_000 && (!sevenDayResetsAtMs || endMs < sevenDayResetsAtMs - 3600_000)) {
      const winMs = sec.window_minutes ? Number(sec.window_minutes) * 60_000 : SEVEN_D_MS;
      gptOfficialPastCycles.push({
        startMs: endMs - winMs,
        endMs,
        naturalResetsAtMs: endMs,
        usedPct: Number(sec.used_percent),
        sourceLabel: 'Codex 会话官方配额记录',
        isResetArchive: false,
        resetMode: 'natural',
        resetSource: 'official'
      });
    }
  }

  const weeklyHistory = buildWeeklyHistoryCycles({
    sortedTurns,
    currentCycleStartMs: cycle7dStartMs,
    sevenDayBudgetUsd,
    fiveHourBudgetUsd,
    officialPastCycles: gptOfficialPastCycles,
    nowMs,
    currentResetMode: gptResolved.resetInfo.mode
  });

  return {
    platform: 'gpt',
    planId: plan.id,
    planName: plan.name,
    monthlyPriceUsd: plan.monthlyPriceUsd,
    fiveHourBudgetUsd: Number(fiveHourBudgetUsd.toFixed(2)),
    sevenDayBudgetUsd: Number(sevenDayBudgetUsd.toFixed(2)),
    isOfficialLiveQuota: isOfficialLiveQuota || gptResolved.isOfficialPctActive,
    quotaSourceLabel,
    accountEmail: codexAuthInfo?.email || null,
    subscriptionUntil: codexAuthInfo?.subscriptionUntil || null,
    syncDiagnostic: quotaSyncDiagnostics.gpt,
    fiveHour: {
      ...stats5h,
      usedPercentage: Number(fiveHourUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - fiveHourUsedPct).toFixed(1)),
      cycleStartAt: new Date(cycle5hStartMs).toISOString(),
      resetsAt: fiveHourResetsAtMs ? new Date(fiveHourResetsAtMs).toISOString() : null,
      resetSource: live5h || latestRolloutRateLimits?.primary ? 'official_live' : 'estimated',
      resetSourceLabel: live5h
        ? 'Codex 官方 WHAM API 实时直连'
        : latestRolloutRateLimits?.primary
        ? 'Codex 会话官方 rate_limits 直连'
        : '本地 5H 离散窗口推算',
      syncedAt: liveQuotaEntry?.syncedAt || liveQuotaEntry?.fiveHour?.asOf || liveQuotaEntry?.updatedAt || null
    },
    sevenDay: {
      ...stats7d,
      usedPercentage: Number(sevenDayUsedPct.toFixed(1)),
      remainingPercentage: Number(Math.max(0, 100 - sevenDayUsedPct).toFixed(1)),
      cycleStartAt: new Date(cycle7dStartMs).toISOString(),
      resetsAt: sevenDayResetsAtMs ? new Date(sevenDayResetsAtMs).toISOString() : null,
      resetSource: gptResolved.isOfficialPctActive ? 'official_live' : liveQuotaEntry?.sevenDay?.resetsAt ? 'official_cached' : 'estimated',
      resetSourceLabel: gptResolved.isOfficialPctActive
        ? 'Codex 官方 WHAM API 实时直连'
        : liveQuotaEntry?.sevenDay?.resetsAt
        ? 'Codex 官方周期顺延对齐'
        : '本地 7D 离散周期推算',
      syncedAt: liveQuotaEntry?.syncedAt || liveQuotaEntry?.sevenDay?.asOf || liveQuotaEntry?.updatedAt || null,
      resetInfo: gptResolved.resetInfo,
      dailyBreakdown,
      weeklyHistory
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

const TIER_DEFINITIONS = [
  { key: 'default', label: '默认', shortLabel: '默认', rank: 0 },
  { key: 'minimal', label: 'Minimal', shortLabel: 'Min', rank: 1 },
  { key: 'low', label: 'Low', shortLabel: 'Low', rank: 2 },
  { key: 'medium', label: 'Medium', shortLabel: 'Med', rank: 3 },
  { key: 'high', label: 'High', shortLabel: 'High', rank: 4 },
  { key: 'xhigh', label: 'xHigh', shortLabel: 'xHigh', rank: 5 },
  { key: 'max', label: 'Max', shortLabel: 'Max', rank: 6 },
  { key: 'ultra', label: 'Ultra', shortLabel: 'Ultra', rank: 7 }
];
const TIER_META_MAP = new Map(TIER_DEFINITIONS.map(t => [t.key, t]));
const TRAILING_EFFORT_RE = /\s*\((minimal|low|medium|high|xhigh|max|ultra)\)\s*$/i;

function splitModelAndTier(rawLabel = '') {
  const label = String(rawLabel || 'Unknown').trim();
  const m = label.match(TRAILING_EFFORT_RE);
  if (m) {
    const tierKey = m[1].toLowerCase();
    const baseModel = label.slice(0, m.index).trim() || label;
    return { baseModel, tierKey };
  }
  return { baseModel: label, tierKey: 'default' };
}

function computeQuantiles(arr) {
  const n = arr ? arr.length : 0;
  if (n === 0) return { median: 0, min: 0, max: 0, p90: 0 };
  const sorted = new Float64Array(n);
  for (let i = 0; i < n; i++) sorted[i] = arr[i];
  sorted.sort();
  const mid = n >> 1;
  const median = (n & 1) === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
  return {
    median,
    min: sorted[0],
    max: sorted[n - 1],
    p90: sorted[Math.min(n - 1, Math.floor(n * 0.9))]
  };
}

function summarizeTaskBucket(
  taskCosts,
  turnCosts,
  turnsCount,
  totalCostUsd,
  totalTokens,
  subagentTasksCount = 0
) {
  const tasksCount = taskCosts.length;
  const taskQ = computeQuantiles(taskCosts);
  const turnQ = computeQuantiles(turnCosts);

  return {
    tasksCount,
    subagentTasksCount,
    turnsCount,
    totalTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(4)),
    avgCostPerTask: tasksCount > 0 ? Number((totalCostUsd / tasksCount).toFixed(4)) : 0,
    medianCostPerTask: Number(taskQ.median.toFixed(4)),
    minCostPerTask: Number(taskQ.min.toFixed(4)),
    maxCostPerTask: Number(taskQ.max.toFixed(4)),
    p90CostPerTask: Number(taskQ.p90.toFixed(4)),
    avgCostPerTurn: turnsCount > 0 ? Number((totalCostUsd / turnsCount).toFixed(5)) : 0,
    medianCostPerTurn: Number(turnQ.median.toFixed(5)),
    p90CostPerTurn: Number(turnQ.p90.toFixed(5)),
    avgTurnsPerTask: tasksCount > 0 ? Number((turnsCount / tasksCount).toFixed(1)) : 0,
    avgTokensPerTask: tasksCount > 0 ? Math.round(totalTokens / tasksCount) : 0
  };
}

function computeModelTierCostAnalysis(allSessions, { cutoffMs = 0, unit = 'session' } = {}) {
  const modelMap = new Map();
  const seenTiers = new Set();
  let totalTurns = 0;
  let totalCostUsd = 0;
  let totalTokens = 0;
  const globalTaskCosts = [];
  const globalTurnCosts = [];

  for (const session of allSessions) {
    if (!Array.isArray(session.turns) || session.turns.length === 0) continue;
    const turnsInWindow =
      cutoffMs > 0
        ? session.turns.filter(t => {
            const ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
            return Number.isNaN(ts) || ts >= cutoffMs;
          })
        : session.turns;
    if (turnsInWindow.length === 0) continue;

    // Group turns into logical task units: either whole session or individual user prompts
    const unitBuckets = new Map();
    for (const t of turnsInWindow) {
      const unitKey = unit === 'prompt' ? `${session.sessionId}#p${t.promptSeq || 1}` : session.sessionId;
      if (!unitBuckets.has(unitKey)) unitBuckets.set(unitKey, []);
      unitBuckets.get(unitKey).push(t);
    }

    for (const unitTurns of unitBuckets.values()) {
      let unitCost = 0;
      const unitModelAccum = new Map();

      for (const t of unitTurns) {
        const tokSum =
          (t.inputTokens || 0) +
          (t.cacheCreationTokens || 0) +
          (t.cacheReadTokens || 0) +
          (t.outputTokens || 0);
        const turnCost = t.totalCostUsd || 0;
        totalTurns += 1;
        totalCostUsd += turnCost;
        totalTokens += tokSum;
        unitCost += turnCost;
        globalTurnCosts.push(turnCost);

        const { baseModel, tierKey } = splitModelAndTier(t.modelLabel || t.model);
        const mKey = `${t.platform}:${baseModel}`;
        if (!unitModelAccum.has(mKey)) {
          unitModelAccum.set(mKey, {
            platform: t.platform,
            baseModel,
            family: t.modelFamily || baseModel,
            hasExternalApi: false,
            costUsd: 0,
            turns: 0,
            tokens: 0,
            turnCosts: [],
            tiers: new Map()
          });
        }
        const sm = unitModelAccum.get(mKey);
        if (t.isExternalApi) sm.hasExternalApi = true;
        sm.costUsd += turnCost;
        sm.turns += 1;
        sm.tokens += tokSum;
        sm.turnCosts.push(turnCost);

        if (!sm.tiers.has(tierKey)) {
          sm.tiers.set(tierKey, { costUsd: 0, turns: 0, tokens: 0, turnCosts: [], hasExternalApi: false });
        }
        const st = sm.tiers.get(tierKey);
        if (t.isExternalApi) st.hasExternalApi = true;
        st.costUsd += turnCost;
        st.turns += 1;
        st.tokens += tokSum;
        st.turnCosts.push(turnCost);
      }

      globalTaskCosts.push(unitCost);

      for (const [mKey, sm] of unitModelAccum) {
        if (!modelMap.has(mKey)) {
          modelMap.set(mKey, {
            key: mKey,
            platform: sm.platform,
            baseModel: sm.baseModel,
            family: sm.family,
            hasExternalApi: false,
            taskCosts: [],
            turnCosts: [],
            subagentTasksCount: 0,
            turnsCount: 0,
            totalCostUsd: 0,
            totalTokens: 0,
            tierMap: new Map()
          });
        }
        const mEntry = modelMap.get(mKey);
        if (sm.hasExternalApi) mEntry.hasExternalApi = true;
        if (session.isSubagent) mEntry.subagentTasksCount += 1;
        mEntry.taskCosts.push(sm.costUsd);
        for (const tc of sm.turnCosts) mEntry.turnCosts.push(tc);
        mEntry.turnsCount += sm.turns;
        mEntry.totalCostUsd += sm.costUsd;
        mEntry.totalTokens += sm.tokens;

        for (const [tierKey, st] of sm.tiers) {
          seenTiers.add(tierKey);
          if (!mEntry.tierMap.has(tierKey)) {
            mEntry.tierMap.set(tierKey, {
              tierKey,
              hasExternalApi: false,
              taskCosts: [],
              turnCosts: [],
              subagentTasksCount: 0,
              turnsCount: 0,
              totalCostUsd: 0,
              totalTokens: 0
            });
          }
          const tEntry = mEntry.tierMap.get(tierKey);
          if (st.hasExternalApi) tEntry.hasExternalApi = true;
          if (session.isSubagent) tEntry.subagentTasksCount += 1;
          tEntry.taskCosts.push(st.costUsd);
          for (const tc of st.turnCosts) tEntry.turnCosts.push(tc);
          tEntry.turnsCount += st.turns;
          tEntry.totalCostUsd += st.costUsd;
          tEntry.totalTokens += st.tokens;
        }
      }
    }
  }

  const availableTiers = TIER_DEFINITIONS.filter(t => seenTiers.has(t.key));
  const models = Array.from(modelMap.values())
    .map(m => {
      const tiers = {};
      const explicitStats = [];
      const allTierStats = [];

      for (const [tierKey, tEntry] of m.tierMap) {
        const meta = TIER_META_MAP.get(tierKey) || { key: tierKey, label: tierKey, shortLabel: tierKey, rank: 99 };
        const summary = {
          tierKey,
          tierLabel: meta.label,
          tierRank: meta.rank,
          hasExternalApi: tEntry.hasExternalApi,
          ...summarizeTaskBucket(
            tEntry.taskCosts,
            tEntry.turnCosts,
            tEntry.turnsCount,
            tEntry.totalCostUsd,
            tEntry.totalTokens,
            tEntry.subagentTasksCount
          )
        };
        tiers[tierKey] = summary;
        allTierStats.push(summary);
        if (tierKey !== 'default') explicitStats.push(summary);
      }

      const spreadPool = explicitStats.length >= 2 ? explicitStats : allTierStats;
      const positiveAvgs = spreadPool.map(s => s.avgCostPerTask).filter(v => v > 0);
      const minAvg = positiveAvgs.length ? Math.min(...positiveAvgs) : 0;
      const maxAvg = positiveAvgs.length ? Math.max(...positiveAvgs) : 0;
      const spreadRatio =
        spreadPool.length >= 2 && minAvg > 0 ? Number((maxAvg / minAvg).toFixed(2)) : null;

      return {
        key: m.key,
        platform: m.platform,
        baseModel: m.baseModel,
        family: m.family,
        hasExternalApi: m.hasExternalApi,
        tierCount: Object.keys(tiers).length,
        explicitTierCount: explicitStats.length,
        spreadRatio,
        overall: summarizeTaskBucket(
          m.taskCosts,
          m.turnCosts,
          m.turnsCount,
          m.totalCostUsd,
          m.totalTokens,
          m.subagentTasksCount
        ),
        tiers
      };
    })
    .sort((a, b) => b.overall.totalCostUsd - a.overall.totalCostUsd);

  return {
    availableTiers,
    summary: summarizeTaskBucket(globalTaskCosts, globalTurnCosts, totalTurns, totalCostUsd, totalTokens),
    models
  };
}

function buildTurnsByPoolMap(allClaudeTurns, allAgyTurns, allGptTurns) {
  const isThirdPartyModel = m => /claude|gpt|opus|sonnet|haiku|fable/i.test(String(m || ''));
  const toSorted = arr => {
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i];
      if (t.ts === undefined) t.ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
      if (!Number.isNaN(t.ts)) out.push(t);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  };
  const agySub = allAgyTurns.filter(t => !t.isExternalApi);
  return {
    claude: toSorted(allClaudeTurns),
    gpt: toSorted(allGptTurns),
    'agy-gemini': toSorted(agySub.filter(t => !isThirdPartyModel(t.model))),
    'agy-tp': toSorted(agySub.filter(t => isThirdPartyModel(t.model)))
  };
}

function extractGptRolloutRateLimits(gptSessions) {
  let latestGptPrimary = null;
  let latestGptSecondary = null;
  const gptSecondarySnapshots = [];
  for (const s of gptSessions) {
    const rl = s.latestRateLimits;
    if (!rl) continue;
    if (rl.primary && typeof rl.primary.used_percent === 'number') {
      const pTs = rl.primary._ts || rl.timestamp || '';
      if (!latestGptPrimary || pTs > (latestGptPrimary._ts || '')) {
        latestGptPrimary = { ...rl.primary, _ts: pTs };
      }
    }
    if (rl.secondary && typeof rl.secondary.used_percent === 'number') {
      const sTs = rl.secondary._ts || rl.timestamp || '';
      gptSecondarySnapshots.push({ ...rl.secondary, _ts: sTs });
      if (!latestGptSecondary || sTs > (latestGptSecondary._ts || '')) {
        latestGptSecondary = { ...rl.secondary, _ts: sTs };
      }
    }
  }
  const latestGptRateLimits =
    latestGptPrimary || latestGptSecondary
      ? {
          primary: latestGptPrimary,
          secondary: latestGptSecondary,
          timestamp: [latestGptPrimary?._ts, latestGptSecondary?._ts].filter(Boolean).sort().at(-1) || ''
        }
      : null;
  return { latestGptRateLimits, gptSecondarySnapshots };
}

function refreshSessionsTurnCosts(sessions) {
  for (const session of sessions) {
    if (!Array.isArray(session.turns)) continue;
    for (const t of session.turns) {
      const cost = calculateTurnCost(t);
      Object.assign(t, cost);
    }
  }
}

export function getQuotaResetsState() {
  const rs = loadQuotaResets();
  const out = {};
  for (const k of WEEKLY_POOL_KEYS) {
    const p = rs.pools[k] || {
      activeOverride: null,
      events: [],
      observed: null,
      fiveHourObserved: null,
      fiveHourEvents: [],
      lastAnchorResetsAt: null
    };
    const combinedEvents = [
      ...(p.events || []).map(e => ({ ...e, window: e.window || '7d' })),
      ...(p.fiveHourEvents || []).map(e => ({ ...e, window: '5h' }))
    ]
      .sort((a, b) => String(b.resetAt || b.createdAt || '').localeCompare(String(a.resetAt || a.createdAt || '')))
      .slice(0, 20);
    out[k] = {
      activeOverride: p.activeOverride || null,
      lastAnchorResetsAt: p.lastAnchorResetsAt || null,
      observed: p.observed || null,
      fiveHourObserved: p.fiveHourObserved || null,
      events: combinedEvents
    };
  }
  return out;
}

export async function syncOfficialQuotasNow({ pool = 'all', clearStaleManual = true } = {}) {
  const tasks = [];
  const syncAgy = pool === 'all' || pool === 'antigravity' || pool === 'agy-gemini' || pool === 'agy-tp';
  const syncClaude = pool === 'all' || pool === 'claude';
  const syncGpt = pool === 'all' || pool === 'gpt';

  if (syncAgy) tasks.push(fetchAntigravityOfficialQuota({ force: true }));
  if (syncClaude) tasks.push(fetchClaudeOfficialOAuthQuota({ force: true }));
  if (syncGpt) tasks.push(fetchCodexOfficialQuota({ force: true }));

  await Promise.all(tasks);

  const liveQuota = loadLiveQuota();
  const rs = loadQuotaResets();
  let resetsDirty = false;
  if (clearStaleManual) {
    const targetPools =
      pool === 'all'
        ? WEEKLY_POOL_KEYS
        : pool === 'antigravity'
        ? ['agy-gemini', 'agy-tp']
        : WEEKLY_POOL_KEYS.includes(pool)
        ? [pool]
        : [];
    for (const pk of targetPools) {
      if (rs.pools[pk]?.activeOverride?.source === 'manual') {
        const hasFreshOfficial =
          (pk === 'claude' && liveQuota.claude?.sevenDay?.resetsAt) ||
          (pk === 'gpt' && liveQuota.gpt?.sevenDay?.resetsAt) ||
          (pk === 'agy-gemini' && liveQuota.antigravity?.pools?.geminiWeekly?.resetsAt) ||
          (pk === 'agy-tp' && liveQuota.antigravity?.pools?.claudeWeekly?.resetsAt);
        if (hasFreshOfficial) {
          rs.pools[pk].activeOverride = null;
          resetsDirty = true;
        }
      }
    }
    if (resetsDirty) saveQuotaResets(rs);
  }
  archiveLiveQuotaSnapshot(liveQuota);

  return {
    ok: true,
    pool,
    syncedAt: new Date().toISOString(),
    diagnostics: { ...quotaSyncDiagnostics },
    liveQuota,
    quotaResets: getQuotaResetsState()
  };
}

export async function warmUpCollector() {
  try {
    ensureDiskCacheLoaded();
    await getDashboardSnapshot({ days: 30, force: false });
  } catch {}
}

export async function triggerManualQuotaReset({ pool, mode, resetAt = null, note = '' }) {
  if (!WEEKLY_POOL_KEYS.includes(pool)) {
    throw new Error(`无效的配额池标识: ${pool}`);
  }
  if (mode !== 'in_cycle' && mode !== 'recalculate') {
    throw new Error(`无效的重置模式: ${mode} (仅支持 in_cycle 或 recalculate)`);
  }

  await refreshPricingModule();
  const nowMs = Date.now();
  const resetAtMs = resetAt ? parseResetTimestampMs(resetAt) : nowMs;
  if (Number.isNaN(resetAtMs)) {
    throw new Error(`无效的重置时间: ${resetAt}`);
  }
  if (resetAtMs > nowMs + 5 * 60_000) {
    throw new Error('重置时间不能超过当前时间 5 分钟以上');
  }

  const settings = loadUserSettings();
  const liveQuota = loadLiveQuota();
  let quotaHistory = loadQuotaHistory();
  let quotaResets = loadQuotaResets();

  const claudeSessions = pool === 'claude' ? scanAllClaudeSessions() : [];
  const agySessions = pool.startsWith('agy-') ? scanAllAntigravitySessions() : [];
  const gptSessions = pool === 'gpt' ? scanAllGptSessions() : [];
  flushDiskCache();

  refreshSessionsTurnCosts([...claudeSessions, ...agySessions, ...gptSessions]);

  const allClaudeTurns = claudeSessions.flatMap(s => s.turns);
  const allAgyTurns = agySessions.flatMap(s => s.turns);
  const allGptTurns = gptSessions.flatMap(s => s.turns);
  const turnsByPool = buildTurnsByPoolMap(allClaudeTurns, allAgyTurns, allGptTurns);

  const reconciled = reconcileExpiredQuotaResets(nowMs, turnsByPool, settings, liveQuota);
  quotaResets = reconciled.quotaResets;
  quotaHistory = reconciled.quotaHistory;

  const claudeOfficialHistory = pool === 'claude' ? loadClaudeOfficialPlanUsage() : null;
  const codexAuthInfo = pool === 'gpt' ? loadCodexAuthInfo() : null;
  const { latestGptRateLimits, gptSecondarySnapshots } =
    pool === 'gpt' ? extractGptRolloutRateLimits(gptSessions) : { latestGptRateLimits: null, gptSecondarySnapshots: [] };

  let currentQuota = null;
  let currentSevenDay = null;
  let currentBudgetUsd = 100;
  let liveSnap = null;
  let windowMs = SEVEN_D_MS_CONST;

  if (pool === 'claude') {
    currentQuota = computeClaudeQuota(allClaudeTurns, settings, liveQuota.claude, claudeOfficialHistory, quotaHistory.claude, quotaResets.pools.claude);
    currentSevenDay = currentQuota.sevenDay;
    currentBudgetUsd = currentQuota.sevenDayBudgetUsd;
    liveSnap = extractPoolSnapshotsFromPayload('claude', liveQuota.claude)[0] || null;
  } else if (pool === 'gpt') {
    currentQuota = computeGptQuota(allGptTurns, settings, liveQuota.gpt, codexAuthInfo, latestGptRateLimits, {
      rolloutSecondaries: gptSecondarySnapshots,
      quotaHistoryRecords: quotaHistory.gpt,
      quotaResetRecord: quotaResets.pools.gpt
    });
    currentSevenDay = currentQuota.sevenDay;
    currentBudgetUsd = currentQuota.sevenDayBudgetUsd;
    liveSnap = extractPoolSnapshotsFromPayload('gpt', liveQuota.gpt)[0] || null;
    if (liveSnap?.windowMs) windowMs = liveSnap.windowMs;
  } else {
    currentQuota = computeAntigravityQuota(allAgyTurns, settings, liveQuota.antigravity, quotaHistory, quotaResets.pools);
    currentSevenDay = pool === 'agy-gemini' ? currentQuota.sevenDay : currentQuota.thirdParty.sevenDay;
    currentBudgetUsd = pool === 'agy-gemini' ? currentQuota.sevenDayBudgetUsd : currentQuota.thirdParty7dBudgetUsd;
    liveSnap = extractPoolSnapshotsFromPayload('antigravity', liveQuota.antigravity).find(s => s.poolKey === pool) || null;
  }

  const prevCycleStartMs = currentSevenDay?.cycleStartAt ? Date.parse(currentSevenDay.cycleStartAt) : resetAtMs - windowMs;
  let prevResetsAtMs = currentSevenDay?.resetsAt ? Date.parse(currentSevenDay.resetsAt) : null;
  if ((!prevResetsAtMs || Number.isNaN(prevResetsAtMs)) && liveSnap?.resetsAtMs) {
    prevResetsAtMs = liveSnap.resetsAtMs;
  }
  if ((!prevResetsAtMs || Number.isNaN(prevResetsAtMs)) && quotaHistory[pool]?.length > 0) {
    const lastHist = quotaHistory[pool].at(-1);
    const hMs = parseResetTimestampMs(lastHist?.naturalResetsAt || lastHist?.resetsAt);
    if (!Number.isNaN(hMs)) prevResetsAtMs = hMs;
  }

  let newNaturalResetsAtMs;
  let keptFallbackToNew7d = false;
  if (mode === 'in_cycle') {
    if (prevResetsAtMs && !Number.isNaN(prevResetsAtMs)) {
      let nat = prevResetsAtMs;
      while (resetAtMs >= nat) {
        nat += windowMs;
      }
      newNaturalResetsAtMs = nat;
    } else {
      newNaturalResetsAtMs = resetAtMs + windowMs;
      keptFallbackToNew7d = true;
    }
  } else {
    newNaturalResetsAtMs = resetAtMs + windowMs;
  }

  const poolTurns = turnsByPool[pool] || [];
  const archiveStartMs =
    Number.isFinite(prevCycleStartMs) && prevCycleStartMs < resetAtMs
      ? prevCycleStartMs
      : Math.max(0, resetAtMs - windowMs);
  const archiveTurns = poolTurns.filter(t => t.ts >= archiveStartMs && t.ts < resetAtMs);
  const archiveCostUsd = Number(archiveTurns.reduce((s, t) => s + t.totalCostUsd, 0).toFixed(2));
  const archiveUsedPct =
    Math.abs(nowMs - resetAtMs) <= 120_000 && typeof currentSevenDay?.usedPercentage === 'number'
      ? Number(currentSevenDay.usedPercentage)
      : Number(Math.min(100, (archiveCostUsd / Math.max(0.01, currentBudgetUsd)) * 100).toFixed(1));

  const eventId = `rst_man_${pool}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const resetAtIso = new Date(resetAtMs).toISOString();
  const newNatIso = new Date(newNaturalResetsAtMs).toISOString();
  const prevNatIso = prevResetsAtMs && !Number.isNaN(prevResetsAtMs) ? new Date(prevResetsAtMs).toISOString() : null;

  let sealed = { dirty: false, replacedBackup: null, historyId: null };
  if (resetAtMs > archiveStartMs + 15_000 && (archiveUsedPct > 0 || archiveTurns.length > 0)) {
    sealed = sealCycleSegmentToHistory(quotaHistory[pool], {
      archiveStartMs,
      archiveEndMs: resetAtMs,
      naturalResetsAtMs: prevResetsAtMs || newNaturalResetsAtMs,
      usedPct: archiveUsedPct,
      mode,
      resetSource: 'manual',
      eventId,
      sourceLabel: mode === 'in_cycle' ? '手动周内重置 (保持原自然重置)' : '手动完全重置 (重算自然重置)',
      existingNatResetToReplaceMs: prevResetsAtMs
    });
    if (sealed.dirty) {
      saveQuotaHistory(quotaHistory);
    }
  }

  const poolState = quotaResets.pools[pool];
  const prevOverrideBackup = poolState.activeOverride ? { ...poolState.activeOverride } : null;
  const defaultNote =
    mode === 'in_cycle'
      ? keptFallbackToNew7d
        ? '周内重置 (原周期无自然重置记录，已暂按 +7天推算)'
        : '周内重置 · 不改变自然重置时间'
      : '完全重置 · 已重新计算自然重置时间 (+7天)';

  const ev = {
    id: eventId,
    pool,
    mode,
    source: 'manual',
    resetAt: resetAtIso,
    cycleStartAt: resetAtIso,
    naturalResetsAt: newNatIso,
    prevCycleStartAt: new Date(archiveStartMs).toISOString(),
    prevResetsAt: prevNatIso,
    prevUsedPct: archiveUsedPct,
    prevCostUsd: archiveCostUsd,
    archivedHistoryId: sealed.historyId,
    replacedBackup: sealed.replacedBackup,
    prevOverrideBackup,
    note: note ? String(note).trim() : defaultNote,
    createdAt: new Date().toISOString()
  };

  poolState.events.push(ev);
  if (poolState.events.length > 50) poolState.events = poolState.events.slice(-50);

  poolState.activeOverride = {
    eventId,
    mode,
    source: 'manual',
    resetAt: resetAtIso,
    cycleStartAt: resetAtIso,
    naturalResetsAt: newNatIso,
    windowMs,
    baseOfficialUsedPct: 0,
    snapshotUsedPctAtReset: liveSnap ? Number(liveSnap.usedPercentage) : archiveUsedPct,
    snapshotResetsAtAtReset: liveSnap?.resetsAt || prevNatIso,
    snapshotAsOfAtReset: liveSnap?.asOf || new Date(nowMs).toISOString(),
    prevCycleStartAt: ev.prevCycleStartAt,
    prevResetsAt: prevNatIso,
    prevUsedPct: archiveUsedPct,
    note: ev.note
  };
  if (mode === 'recalculate') {
    poolState.lastAnchorResetsAt = newNatIso;
  }
  saveQuotaResets(quotaResets);

  // Recompute updated sevenDay for immediate response
  let updatedQuota = null;
  if (pool === 'claude') {
    updatedQuota = computeClaudeQuota(allClaudeTurns, settings, liveQuota.claude, claudeOfficialHistory, quotaHistory.claude, quotaResets.pools.claude);
  } else if (pool === 'gpt') {
    updatedQuota = computeGptQuota(allGptTurns, settings, liveQuota.gpt, codexAuthInfo, latestGptRateLimits, {
      rolloutSecondaries: gptSecondarySnapshots,
      quotaHistoryRecords: quotaHistory.gpt,
      quotaResetRecord: quotaResets.pools.gpt
    });
  } else {
    updatedQuota = computeAntigravityQuota(allAgyTurns, settings, liveQuota.antigravity, quotaHistory, quotaResets.pools);
  }

  return {
    ok: true,
    pool,
    mode,
    resetEvent: ev,
    sevenDay:
      pool === 'agy-tp'
        ? updatedQuota.thirdParty.sevenDay
        : updatedQuota.sevenDay,
    quotaResets: getQuotaResetsState()
  };
}

export function revertManualQuotaReset({ pool }) {
  if (!WEEKLY_POOL_KEYS.includes(pool)) {
    throw new Error(`无效的配额池标识: ${pool}`);
  }
  const quotaResets = loadQuotaResets();
  const quotaHistory = loadQuotaHistory();
  const poolState = quotaResets.pools[pool];
  const ov = poolState?.activeOverride;

  if (!ov || ov.source !== 'manual') {
    return {
      ok: false,
      reverted: false,
      message: '当前配额池没有可撤销的手动重置覆盖',
      quotaResets: getQuotaResetsState()
    };
  }

  const eventId = ov.eventId;
  const evIdx = poolState.events.findIndex(e => e.id === eventId);
  const ev = evIdx >= 0 ? poolState.events[evIdx] : null;
  if (evIdx >= 0) {
    poolState.events.splice(evIdx, 1);
  }

  // Restore quota_history.json entry if it was sealed or replaced by this manual event
  const list = quotaHistory[pool] || [];
  let historyDirty = false;
  if (ev?.replacedBackup) {
    const idx = list.findIndex(item => item.resetEventId === eventId || item.id === ev.archivedHistoryId);
    if (idx >= 0) {
      list[idx] = ev.replacedBackup;
      historyDirty = true;
    }
  } else if (eventId) {
    const nextList = list.filter(item => item.resetEventId !== eventId && item.id !== ev?.archivedHistoryId);
    if (nextList.length !== list.length) {
      quotaHistory[pool] = nextList;
      historyDirty = true;
    }
  }
  if (historyDirty) {
    quotaHistory[pool].sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
    saveQuotaHistory(quotaHistory);
  }

  // Restore previous override if still valid and not expired
  const prevOv = ev?.prevOverrideBackup || null;
  if (prevOv && prevOv.naturalResetsAt && Date.now() < Date.parse(prevOv.naturalResetsAt)) {
    poolState.activeOverride = prevOv;
  } else {
    poolState.activeOverride = null;
  }

  // Recompute lastAnchorResetsAt from remaining recalculate events
  const lastRecalc = [...poolState.events].reverse().find(e => e.mode === 'recalculate');
  poolState.lastAnchorResetsAt = lastRecalc?.naturalResetsAt || null;

  saveQuotaResets(quotaResets);
  return {
    ok: true,
    reverted: true,
    pool,
    revertedEventId: eventId,
    quotaResets: getQuotaResetsState()
  };
}

function raceWithBudget(promise, budgetMs) {
  if (!budgetMs || budgetMs <= 0) return promise;
  return Promise.race([
    promise.catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), budgetMs))
  ]);
}

export async function getDashboardSnapshot({ days = 30, tz = null, force = false } = {}) {
  const settings = loadUserSettings();
  const normTz = normalizeTimezoneId(tz || settings.timezone || 'Asia/Shanghai');
  const inflightKey = `${days}|${normTz}|${force ? '1' : '0'}`;
  if (inFlightSnapshots.has(inflightKey)) {
    return inFlightSnapshots.get(inflightKey);
  }
  const job = computeDashboardSnapshotInternal({ days, tz: normTz, force, settings });
  inFlightSnapshots.set(inflightKey, job);
  try {
    return await job;
  } finally {
    inFlightSnapshots.delete(inflightKey);
  }
}

async function computeDashboardSnapshotInternal({ days = 30, tz = 'Asia/Shanghai', force = false, settings }) {
  const startPerf = performance.now();
  await refreshPricingModule();
  activeTimezoneId = tz;

  // Fetch live official quotas (Antigravity LS RPC + Claude OAuth + Codex WHAM):
  // - When `force` is true: await full fresh responses (with Antigravity forceRefresh=true)
  // - On normal loads: run in parallel with session scans using a tight budget so remote network latency never stalls UI!
  const cachedLiveOnDisk = loadLiveQuota();
  const agyQuotaPromise = fetchAntigravityOfficialQuota({ force });
  const claudeQuotaPromise = fetchClaudeOfficialOAuthQuota({ force });
  const codexQuotaPromise = fetchCodexOfficialQuota({ force });

  const agySessionsPromise = scanAllAntigravitySessionsAsync({ force });
  const claudeSessions = scanAllClaudeSessions({ force });
  const gptSessions = scanAllGptSessions({ force });
  const agySessions = await agySessionsPromise;
  flushDiskCache();

  if (force) {
    await Promise.all([agyQuotaPromise, claudeQuotaPromise, codexQuotaPromise]);
  } else {
    // Give local Antigravity RPC up to 600ms (usually 50-300ms) and remote APIs up to 350ms if cached on disk (otherwise 800ms);
    // any slower remote call still finishes in background and persists to live_quota.json.
    const agyBudget = cachedLiveOnDisk.antigravity ? 550 : 1200;
    const claudeBudget = cachedLiveOnDisk.claude ? 300 : 700;
    const gptBudget = cachedLiveOnDisk.gpt ? 350 : 900;
    await Promise.all([
      raceWithBudget(agyQuotaPromise, agyBudget),
      raceWithBudget(claudeQuotaPromise, claudeBudget),
      raceWithBudget(codexQuotaPromise, gptBudget)
    ]);
  }

  const liveQuota = loadLiveQuota();
  let quotaHistory = archiveLiveQuotaSnapshot(liveQuota);
  const claudeOfficialHistory = loadClaudeOfficialPlanUsage();
  const codexAuthInfo = loadCodexAuthInfo();

  const allSessions = [...claudeSessions, ...agySessions, ...gptSessions];

  // Dynamically refresh turn pricing & model labels only when pricingVersion changed or turn not yet priced
  const seenModelNames = new Set();
  for (const session of allSessions) {
    if (!Array.isArray(session.turns)) continue;
    for (const t of session.turns) {
      if (t._ts === undefined) {
        t._ts = Date.parse(t.timestamp);
      }
      if (t._pricedVer !== ENGINE_VERSION || typeof t.totalCostUsd !== 'number') {
        const cost = calculateTurnCost(t);
        Object.assign(t, cost);
        t._pricedVer = ENGINE_VERSION;
      }
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

  let maxLastTs = '';
  for (let i = 0; i < allSessions.length; i++) {
    const lt = allSessions[i].lastTimestamp || '';
    if (lt > maxLastTs) maxLastTs = lt;
  }
  const sessionsSig = `${ENGINE_VERSION}|${allSessions.length}|${allClaudeTurns.length}|${allAgyTurns.length}|${allGptTurns.length}|${maxLastTs}`;
  const liveSig = `${liveQuota.antigravity?.updatedAt || ''}|${liveQuota.claude?.updatedAt || ''}|${liveQuota.gpt?.updatedAt || ''}`;
  const settingsSig = `${settings.claudePlan}|${settings.antigravityPlan}|${settings.gptPlan}|${settings.customClaude5hUsd}|${settings.customAgy5hUsd}|${settings.customGpt5hUsd}`;
  const fullDataSig = `${sessionsSig}|${liveSig}|${settingsSig}`;
  const snapCacheKey = `${days}|${activeTimezoneId}`;
  const cachedSnap = memoizedHeavyAgg.lastSnapshots.get(snapCacheKey);
  if (
    !force &&
    cachedSnap &&
    cachedSnap.dataSig === fullDataSig &&
    Date.now() - cachedSnap.createdAt < 6000
  ) {
    return {
      ...cachedSnap.snapshot,
      generatedAt: new Date().toISOString(),
      scanDurationMs: Number((performance.now() - startPerf).toFixed(1)),
      quotaSyncDiagnostics: { ...quotaSyncDiagnostics }
    };
  }

  const nowMs = Date.now();
  const turnsByPool = buildTurnsByPoolMap(allClaudeTurns, allAgyTurns, allGptTurns);
  const reconciled = reconcileExpiredQuotaResets(nowMs, turnsByPool, settings, liveQuota);
  const quotaResets = reconciled.quotaResets;
  quotaHistory = reconciled.quotaHistory;

  const { latestGptRateLimits, gptSecondarySnapshots } = extractGptRolloutRateLimits(gptSessions);

  // Quota calculations with exact cycle alignment, quota resets & official quota calibration
  const quotaStatus = {
    claude: computeClaudeQuota(
      allClaudeTurns,
      settings,
      liveQuota.claude,
      claudeOfficialHistory,
      quotaHistory.claude,
      quotaResets.pools.claude
    ),
    antigravity: computeAntigravityQuota(
      allAgyTurns,
      settings,
      liveQuota.antigravity,
      quotaHistory,
      quotaResets.pools
    ),
    gpt: computeGptQuota(
      allGptTurns,
      settings,
      liveQuota.gpt,
      codexAuthInfo,
      latestGptRateLimits,
      {
        rolloutSecondaries: gptSecondarySnapshots,
        quotaHistoryRecords: quotaHistory.gpt,
        quotaResetRecord: quotaResets.pools.gpt
      }
    )
  };

  // Date range filter for dashboard charts & tables (using activeTimezoneId)
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
    antigravity: { turns: 0, sessions: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, cacheSavingsUsd: 0, geminiTurns: 0, geminiCostUsd: 0, thirdPartyTurns: 0, thirdPartyCostUsd: 0, externalApiTurns: 0, externalApiCostUsd: 0 },
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
      const ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
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
          if (t.isExternalApi) {
            pT.externalApiTurns += 1;
            pT.externalApiCostUsd += t.totalCostUsd;
          } else if (/claude|gpt|opus|sonnet|haiku|fable/i.test(String(t.model || ''))) {
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

        const mKey = `${t.platform}:${t.isExternalApi ? 'api:' : ''}${t.modelLabel}`;
        if (!todayModelMap.has(mKey)) {
          todayModelMap.set(mKey, {
            key: mKey,
            platform: t.platform,
            model: t.modelLabel,
            isExternalApi: Boolean(t.isExternalApi),
            billingSource: t.billingSource || (t.isExternalApi ? 'vertex-ai' : 'subscription'),
            turns: 0,
            inputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            cacheSavingsUsd: 0,
            tpsTracker: createTpsTracker(true)
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
  const annualSig = `${sessionsSig}|${activeTimezoneId}|${todayDateStr}`;
  let annualDailySeries;
  if (memoizedHeavyAgg.annualSig === annualSig && memoizedHeavyAgg.annualSeries) {
    annualDailySeries = memoizedHeavyAgg.annualSeries;
  } else {
    const annualDailyMap = new Map();
    const annualCutoffMs = Date.now() - 370 * 86400_000;
    for (const session of allSessions) {
      for (const t of session.turns) {
        const ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
        if (Number.isNaN(ts) || ts < annualCutoffMs) continue;
        const dayKey = toLocalDateStr(ts);
        if (!dayKey) continue;
        if (!annualDailyMap.has(dayKey)) {
          annualDailyMap.set(dayKey, {
            date: dayKey,
            claudeTokens: 0,
            agyTokens: 0,
            gptTokens: 0,
            apiTokens: 0,
            claudeCostUsd: 0,
            agyCostUsd: 0,
            gptCostUsd: 0,
            apiCostUsd: 0,
            claudeTurns: 0,
            agyTurns: 0,
            gptTurns: 0,
            apiTurns: 0
          });
        }
        const entry = annualDailyMap.get(dayKey);
        const tokSum = t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens + t.outputTokens;
        if (t.isExternalApi) {
          entry.apiTokens += tokSum;
          entry.apiCostUsd += t.totalCostUsd;
          entry.apiTurns += 1;
        } else if (t.platform === 'claude') {
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
    annualDailySeries = Array.from(annualDailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    memoizedHeavyAgg.annualSig = annualSig;
    memoizedHeavyAgg.annualSeries = annualDailySeries;
  }

  const modelMap = new Map();
  const projectMap = new Map();
  const hourlyCounts = Array.from({ length: 24 }, (_, h) => ({ hour: h, claudeTurns: 0, agyTurns: 0, gptTurns: 0, tokens: 0 }));
  const filteredSessions = [];

  for (const session of allSessions) {
    const turnsInWindow = session.turns.filter(t => {
      const ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
      return Number.isNaN(ts) || ts >= cutoffMs;
    });
    if (turnsInWindow.length === 0) continue;

    let sInput = 0, sCacheWrite = 0, sCacheRead = 0, sOutput = 0, sCost = 0, sSavings = 0;
    let sExternalTurns = 0, sSubTurns = 0;
    const sessionModels = new Set();
    const sessionTpsTracker = createTpsTracker();

    for (const t of turnsInWindow) {
      if (t.isExternalApi) sExternalTurns += 1;
      else sSubTurns += 1;
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
      const ts = t._ts !== undefined ? t._ts : Date.parse(t.timestamp);
      if (!Number.isNaN(ts)) {
        const dayKey = toLocalDateStr(ts);
        if (!dailyMap.has(dayKey)) {
          dailyMap.set(dayKey, {
            date: dayKey,
            claudeTokens: 0,
            agyTokens: 0,
            gptTokens: 0,
            apiTokens: 0,
            claudeCostUsd: 0,
            agyCostUsd: 0,
            gptCostUsd: 0,
            apiCostUsd: 0,
            claudeTurns: 0,
            agyTurns: 0,
            gptTurns: 0,
            apiTurns: 0,
            claudeTpsTracker: createTpsTracker(),
            agyTpsTracker: createTpsTracker(),
            gptTpsTracker: createTpsTracker(),
            apiTpsTracker: createTpsTracker()
          });
        }
        const dayEntry = dailyMap.get(dayKey);
        if (t.isExternalApi) {
          dayEntry.apiTokens += tokSum;
          dayEntry.apiCostUsd += t.totalCostUsd;
          dayEntry.apiTurns += 1;
          addTurnToTpsTracker(dayEntry.apiTpsTracker, t);
        } else if (t.platform === 'claude') {
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
      const mKey = `${t.platform}:${t.isExternalApi ? 'api:' : ''}${t.modelLabel}`;
      if (!modelMap.has(mKey)) {
        modelMap.set(mKey, {
          key: mKey,
          platform: t.platform,
          model: t.modelLabel,
          family: t.modelFamily,
          isExternalApi: Boolean(t.isExternalApi),
          billingSource: t.billingSource || (t.isExternalApi ? 'vertex-ai' : 'subscription'),
          turns: 0,
          inputTokens: 0,
          cacheWriteTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          cacheSavingsUsd: 0,
          tpsTracker: createTpsTracker(true)
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

    const billingMode =
      sExternalTurns > 0 ? (sSubTurns > 0 ? 'mixed' : 'external_api') : 'subscription';

    filteredSessions.push({
      sessionId: session.sessionId,
      platform: session.platform,
      surface: session.surface,
      billingMode,
      isExternalApi: billingMode === 'external_api',
      externalApiTurns: sExternalTurns,
      billingSource: session.billingSource || (billingMode === 'external_api' ? 'vertex-ai' : 'subscription'),
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
    .map(({ claudeTpsTracker, agyTpsTracker, gptTpsTracker, apiTpsTracker, ...d }) => {
      const cTps = finalizeTpsTracker(claudeTpsTracker);
      const aTps = finalizeTpsTracker(agyTpsTracker);
      const gTps = finalizeTpsTracker(gptTpsTracker);
      const xTps = finalizeTpsTracker(apiTpsTracker);
      return {
        ...d,
        claudeAvgTps: cTps.avgTps,
        claudePeakTps: cTps.peakTps,
        agyAvgTps: aTps.avgTps,
        agyPeakTps: aTps.peakTps,
        gptAvgTps: gTps.avgTps,
        gptPeakTps: gTps.peakTps,
        apiAvgTps: xTps.avgTps,
        apiPeakTps: xTps.peakTps
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

  let tierCostAll;
  if (memoizedHeavyAgg.tierAllSig === sessionsSig && memoizedHeavyAgg.tierAll) {
    tierCostAll = memoizedHeavyAgg.tierAll;
  } else {
    tierCostAll = {
      prompt: computeModelTierCostAnalysis(allSessions, { cutoffMs: 0, unit: 'prompt' }),
      session: computeModelTierCostAnalysis(allSessions, { cutoffMs: 0, unit: 'session' })
    };
    memoizedHeavyAgg.tierAllSig = sessionsSig;
    memoizedHeavyAgg.tierAll = tierCostAll;
  }
  const tierCostPeriod =
    cutoffMs > 0
      ? {
          prompt: computeModelTierCostAnalysis(allSessions, { cutoffMs, unit: 'prompt' }),
          session: computeModelTierCostAnalysis(allSessions, { cutoffMs, unit: 'session' })
        }
      : tierCostAll;

  const scanDurationMs = Number((performance.now() - startPerf).toFixed(1));

  const snapshotResult = {
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    timezone: activeTimezoneId,
    timezoneLabel: getTzLabel(activeTimezoneId),
    scanDurationMs,
    daysFilter: days,
    settings,
    plansCatalog: activePricing.SUBSCRIPTION_PLANS || SUBSCRIPTION_PLANS,
    quotaStatus,
    quotaResets: getQuotaResetsState(),
    quotaSyncDiagnostics: { ...quotaSyncDiagnostics },
    todayStats: todayTotals,
    totals,
    dailySeries,
    annualDailySeries,
    hourlyCounts,
    models,
    tierCostStats: {
      all: tierCostAll,
      period: tierCostPeriod
    },
    modelRegistry: getModelRegistrySummary(),
    projects: projects.slice(0, 50),
    recentSessions: filteredSessions.slice(0, 100)
  };
  memoizedHeavyAgg.lastSnapshots.set(snapCacheKey, {
    createdAt: Date.now(),
    dataSig: fullDataSig,
    snapshot: snapshotResult
  });
  return snapshotResult;
}
