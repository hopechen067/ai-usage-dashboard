// Dynamic model registry: auto-discovers new models (e.g. Gemini 4 Carbon) so they no longer
// fall through the static pricing table as "Unknown Model".
//
// Sources of discovery:
//   1. Antigravity language_server RPC `GetUserStatus.clientModelConfigs` (the live model list)
//   2. Model names observed in session transcripts (Claude / Antigravity / Codex)
//
// Pricing for models missing from MODEL_PRICING is resolved in this order:
//   data/model_overrides.json  >  inherit from the closest known sibling (same provider + major version)  >  default
//
// Files (all under data/, git-ignored):
//   discovered_models.json  - auto-generated registry (do not edit)
//   model_overrides.json    - OPTIONAL, user-editable manual prices, e.g.
//     { "gemini-4-carbon": { "inputPer1M": 3, "outputPer1M": 15, "cacheReadPer1M": 0.15, "quotaWeight": 1.5 } }

import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'discovered_models.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'model_overrides.json');

const EFFORT_RE = /\b(xhigh|high|medium|low|minimal)\b/i;
const SEEN_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

// ---------- small mtime-cached JSON reader ----------
const jsonCache = new Map();
function readJsonCached(file, fallback) {
  try {
    const st = fs.statSync(file);
    const hit = jsonCache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    jsonCache.delete(file);
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  jsonCache.delete(file);
}

// ---------- name helpers ----------
export function detectEffort(raw = '') {
  const m = String(raw).match(EFFORT_RE);
  return m ? m[1].toLowerCase() : '';
}

/** "Gemini 4 Carbon (High)" / "gemini-4-carbon-high" -> "gemini-4-carbon" */
export function slugifyModel(raw = '') {
  return String(raw)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(EFFORT_RE, ' ')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function detectProvider(raw = '') {
  const s = String(raw).toLowerCase();
  if (/gemini|gemma|argon|carbon|flash/.test(s)) return 'Google';
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(s)) return 'Anthropic';
  if (/gpt|codex|\bo\d\b|\bo\d-/.test(s)) return 'OpenAI';
  return 'Unknown';
}

function prettify(raw = '') {
  const effort = detectEffort(raw);
  const base = slugifyModel(raw)
    .split('-')
    .filter(Boolean)
    .map(w => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
  const effLabel = effort === 'xhigh' ? 'xHigh' : effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : '';
  return effLabel ? `${base} (${effLabel})` : base;
}

// ---------- registry persistence ----------
export function loadRegistry() {
  const r = readJsonCached(REGISTRY_FILE, null);
  return r && typeof r === 'object' && r.models ? r : { updatedAt: null, models: {} };
}

export function loadOverrides() {
  const o = readJsonCached(OVERRIDES_FILE, {});
  return o && typeof o === 'object' ? o : {};
}

function stripQuota(cfg) {
  // Drop volatile quota data and bulky capability tables; keep identity/metadata only
  const { quotaInfo, supportedMimeTypes, ...rest } = cfg || {};
  return rest;
}

/**
 * Merge `clientModelConfigs` from the language server into the registry.
 * Returns the list of newly discovered model ids.
 */
export function syncRpcModels(configs = []) {
  if (!Array.isArray(configs) || configs.length === 0) return [];
  const reg = loadRegistry();
  const now = Date.now();
  const added = [];
  let dirty = false;

  for (const cfg of configs) {
    const id = String(cfg?.modelId || cfg?.model || '').trim();
    if (!id) continue;
    const label = String(cfg.label || '').trim() || prettify(id);
    const prev = reg.models[id];
    if (!prev) {
      reg.models[id] = {
        id,
        label,
        slug: slugifyModel(id),
        effort: detectEffort(id) || detectEffort(label),
        provider: detectProvider(`${id} ${label}`),
        source: 'language_server_rpc',
        firstSeen: new Date(now).toISOString(),
        lastSeen: new Date(now).toISOString(),
        raw: stripQuota(cfg)
      };
      added.push(id);
      dirty = true;
    } else {
      const rawNow = JSON.stringify(stripQuota(cfg));
      if (prev.label !== label || JSON.stringify(prev.raw) !== rawNow) {
        prev.label = label;
        prev.raw = stripQuota(cfg);
        dirty = true;
      }
      if (now - Date.parse(prev.lastSeen || 0) > SEEN_TOUCH_INTERVAL_MS) {
        prev.lastSeen = new Date(now).toISOString();
        dirty = true;
      }
    }
  }

  if (dirty) {
    reg.updatedAt = new Date(now).toISOString();
    writeJson(REGISTRY_FILE, reg);
  }
  if (added.length) console.log(`[model-registry] 发现新模型: ${added.join(', ')}`);
  return added;
}

/**
 * Record model names seen in transcripts that are not in the static pricing table.
 * Returns the names that were newly recorded.
 */
export function noteSeenModels(names, isKnown = () => false) {
  const reg = loadRegistry();
  const now = Date.now();
  const added = [];
  let dirty = false;

  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name || name === 'unknown' || name.startsWith('__') || name.startsWith('([') || isKnown(name)) continue;
    const id = `seen:${name.toLowerCase()}`;
    const prev = reg.models[id];
    if (!prev) {
      reg.models[id] = {
        id,
        label: prettify(name),
        slug: slugifyModel(name),
        effort: detectEffort(name),
        provider: detectProvider(name),
        source: 'transcript',
        rawName: name,
        firstSeen: new Date(now).toISOString(),
        lastSeen: new Date(now).toISOString()
      };
      added.push(name);
      dirty = true;
    } else if (now - Date.parse(prev.lastSeen || 0) > SEEN_TOUCH_INTERVAL_MS) {
      prev.lastSeen = new Date(now).toISOString();
      dirty = true;
    }
  }

  if (dirty) {
    reg.updatedAt = new Date(now).toISOString();
    writeJson(REGISTRY_FILE, reg);
  }
  if (added.length) console.log(`[model-registry] 对话日志中发现未登记模型: ${added.join(', ')}`);
  return added;
}

// ---------- resolution for models missing from MODEL_PRICING ----------
function findRegistryLabel(slug, effort) {
  const reg = loadRegistry();
  let fallback = null;
  for (const e of Object.values(reg.models)) {
    if (e.slug !== slug) continue;
    if ((e.effort || '') === effort) return e.label;
    fallback = fallback || e;
  }
  if (fallback) return prettify(effort ? `${slug}-${effort}` : slug);
  return null;
}

/** Pick the closest known sibling key: same provider + same leading "name-major" prefix (e.g. gemini-4). */
function findSiblingKey(slug, knownKeys) {
  const tokens = slug.split('-');
  for (let n = Math.min(tokens.length - 1, 2); n >= 1; n--) {
    const prefix = tokens.slice(0, n).join('-');
    const matches = knownKeys.filter(k => k.startsWith(`${prefix}-`) && k !== slug);
    if (matches.length) {
      // Prefer the un-suffixed base key (no effort tier) of the first matching family.
      const base = matches.find(k => !EFFORT_RE.test(k)) || matches[0];
      return base;
    }
  }
  return null;
}

/**
 * Resolve metadata for a model that is NOT in MODEL_PRICING.
 * Returns { slug, label, family, provider, overrides, inheritFrom, source } where `inheritFrom`
 * is a known MODEL_PRICING key (or null). The caller (pricing.mjs) merges real rates, so
 * time-based rules of the sibling (e.g. Argon intro -> standard) keep applying.
 */
export function resolveUnknownModel(rawModel, knownKeys = []) {
  const raw = String(rawModel || '').trim();
  const slug = slugifyModel(raw);
  if (!slug) return null;
  const effort = detectEffort(raw);
  const overrides = loadOverrides();
  const ov = overrides[slug] || overrides[raw.toLowerCase()] || null;

  const inheritFrom =
    (ov?.inheritFrom && knownKeys.includes(ov.inheritFrom) ? ov.inheritFrom : null) ||
    findSiblingKey(slug, knownKeys);

  const family = prettify(slug);
  return {
    slug,
    label: ov?.label || findRegistryLabel(slug, effort) || prettify(raw),
    family: ov?.family || family,
    provider: ov?.provider || detectProvider(raw),
    overrides: ov,
    inheritFrom,
    source: ov ? 'override' : inheritFrom ? 'inherited' : 'default'
  };
}

/** Summary used by CLI / snapshot: every discovered model and how it is priced. */
export function describeRegistry(knownKeys = [], knownModelFor = () => false) {
  const reg = loadRegistry();
  const rows = Object.values(reg.models).map(e => {
    const probe = e.rawName || e.id;
    const known = knownModelFor(probe);
    const r = known ? null : resolveUnknownModel(probe, knownKeys);
    return {
      id: e.id,
      label: e.label,
      provider: e.provider,
      source: e.source,
      firstSeen: e.firstSeen,
      pricing: known ? 'builtin' : r?.source || 'default',
      inheritFrom: r?.inheritFrom || null
    };
  });
  return { updatedAt: reg.updatedAt, models: rows };
}

export const MODEL_REGISTRY_PATHS = { REGISTRY_FILE, OVERRIDES_FILE };
