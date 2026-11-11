// Model pricing & Subscription Quota estimation engine
// Prices are in USD per 1M tokens (API-equivalent value for subscription ROI & quota weighting)

import { resolveUnknownModel } from './model-registry.mjs';

export const PRICING_VERSION = 14;

// Gemini 4 Argon Official Rates:
// Thinking effort (low / medium / high) uses the exact same unit price!
// Output price includes thinking tokens.
// Implicit caching (prompt >= 4096) provides a 95% discount (5% of input price), cacheWrite is $0.
export const ARGON_STANDARD_START_MS = Date.parse('2026-12-01T00:00:00Z');

export const GEMINI_ARGON_RATES = {
  intro: {
    tier: 'intro',
    label: '介绍期（至 2026-11-30）',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.10 // 95% 折扣 ($2.00 * 0.05)
  },
  standard: {
    tier: 'standard',
    label: '标准价（2026-12-01 起）',
    inputPer1M: 4.0,
    outputPer1M: 20.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.20 // 95% 折扣 ($4.00 * 0.05)
  }
};

export const MODEL_PRICING = {
  // Claude 5.5 family (Official Anthropic latest pricing)
  // Claude Opus 5.5: $4.00 Input / $20.00 Output per 1M (Cache write: $5.00, Cache hit: $0.20)
  // Claude Sonnet 5.5: $2.00 Input / $10.00 Output per 1M (Cache write: $2.50, Cache hit: $0.10)
  // Claude Haiku 5.5: $0.10 Input / $0.50 Output per 1M (Cache write: $0.125, Cache hit: $0.01)
  // Thinking effort levels (High / Medium / Low) use the EXACT SAME unit price and quota weight.
  // Differences in cost come purely from actual thinking tokens generated.

  // Claude Opus 5.5 family
  'claude-opus-5-5-high': {
    label: 'Claude Opus 5.5 (High)',
    family: 'Claude Opus',
    provider: 'Anthropic',
    inputPer1M: 4.0,
    outputPer1M: 20.0,
    cacheWritePer1M: 5.0,
    cacheReadPer1M: 0.20,
    quotaWeight: 2.0
  },
  'claude-opus-5-5-medium': {
    label: 'Claude Opus 5.5 (Medium)',
    family: 'Claude Opus',
    provider: 'Anthropic',
    inputPer1M: 4.0,
    outputPer1M: 20.0,
    cacheWritePer1M: 5.0,
    cacheReadPer1M: 0.20,
    quotaWeight: 2.0
  },
  'claude-opus-5-5-low': {
    label: 'Claude Opus 5.5 (Low)',
    family: 'Claude Opus',
    provider: 'Anthropic',
    inputPer1M: 4.0,
    outputPer1M: 20.0,
    cacheWritePer1M: 5.0,
    cacheReadPer1M: 0.20,
    quotaWeight: 2.0
  },
  'claude-opus-5-5': {
    label: 'Claude Opus 5.5',
    family: 'Claude Opus',
    provider: 'Anthropic',
    inputPer1M: 4.0,
    outputPer1M: 20.0,
    cacheWritePer1M: 5.0,
    cacheReadPer1M: 0.20,
    quotaWeight: 2.0
  },

  // Claude Sonnet 5.5 family
  'claude-sonnet-5-5-high': {
    label: 'Claude Sonnet 5.5 (High)',
    family: 'Claude Sonnet',
    provider: 'Anthropic',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 2.50,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  },
  'claude-sonnet-5-5-medium': {
    label: 'Claude Sonnet 5.5 (Medium)',
    family: 'Claude Sonnet',
    provider: 'Anthropic',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 2.50,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  },
  'claude-sonnet-5-5-low': {
    label: 'Claude Sonnet 5.5 (Low)',
    family: 'Claude Sonnet',
    provider: 'Anthropic',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 2.50,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  },
  'claude-sonnet-5-5': {
    label: 'Claude Sonnet 5.5',
    family: 'Claude Sonnet',
    provider: 'Anthropic',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 2.50,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  },

  // Claude Haiku 5.5 family
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5',
    family: 'Claude Haiku',
    provider: 'Anthropic',
    inputPer1M: 0.10,
    outputPer1M: 0.50,
    cacheWritePer1M: 0.125,
    cacheReadPer1M: 0.01,
    quotaWeight: 0.05
  },

  // Legacy Claude 5.0 Models
  'claude-opus-5': {
    label: 'Claude Opus 5',
    family: 'Claude Opus',
    provider: 'Anthropic',
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheWritePer1M: 6.25,
    cacheReadPer1M: 0.50,
    quotaWeight: 2.0
  },
  'claude-sonnet-5': {
    label: 'Claude Sonnet 5',
    family: 'Claude Sonnet',
    provider: 'Anthropic',
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.30,
    quotaWeight: 1.0
  },
  'claude-fable-5-2': {
    label: 'Claude Fable 5.2',
    family: 'Claude Fable',
    provider: 'Anthropic',
    inputPer1M: 8.0,
    outputPer1M: 40.0,
    cacheWritePer1M: 10.0,
    cacheReadPer1M: 0.40,
    quotaWeight: 4.0
  },
  'claude-fable-5-1': {
    label: 'Claude Fable 5.1',
    family: 'Claude Fable',
    provider: 'Anthropic',
    inputPer1M: 4.0,
    outputPer1M: 20.0,
    cacheWritePer1M: 5.0,
    cacheReadPer1M: 0.20,
    quotaWeight: 2.0
  },

  // Gemini 4 Argon family
  // Official rule: Thinking effort levels (low / medium / high) share the exact same unit price and quota weight!
  // Cost differences come purely from thinking token volume.
  'gemini-4-argon-high': {
    label: 'Gemini 4 Argon (High)',
    family: 'Gemini 4 Argon',
    provider: 'Google',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  },
  'gemini-4-argon-medium': {
    label: 'Gemini 4 Argon (Medium)',
    family: 'Gemini 4 Argon',
    provider: 'Google',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  },
  'gemini-4-argon-low': {
    label: 'Gemini 4 Argon (Low)',
    family: 'Gemini 4 Argon',
    provider: 'Google',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  },
  'gemini-4-argon': {
    label: 'Gemini 4 Argon',
    family: 'Gemini 4 Argon',
    provider: 'Google',
    inputPer1M: 2.0,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  },

  // Gemini 3.8 Flash family (Introductory: $0.75 / $3.75 / $0.075 through 2026-12-31)
  'gemini-flash-high': {
    label: 'Gemini 3.8 Flash (High)',
    family: 'Gemini Flash',
    provider: 'Google',
    inputPer1M: 0.75,
    outputPer1M: 3.75,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.075,
    quotaWeight: 0.375
  },
  'gemini-flash-medium': {
    label: 'Gemini 3.8 Flash (Medium)',
    family: 'Gemini Flash',
    provider: 'Google',
    inputPer1M: 0.75,
    outputPer1M: 3.75,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.075,
    quotaWeight: 0.375
  },
  'gemini-flash-low': {
    label: 'Gemini 3.8 Flash (Low)',
    family: 'Gemini Flash',
    provider: 'Google',
    inputPer1M: 0.75,
    outputPer1M: 3.75,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.075,
    quotaWeight: 0.375
  },
  'gemini-flash': {
    label: 'Gemini 3.8 Flash',
    family: 'Gemini Flash',
    provider: 'Google',
    inputPer1M: 0.75,
    outputPer1M: 3.75,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.075,
    quotaWeight: 0.375
  },

  // Legacy / Other Models
  'gemini-3': {
    label: 'Gemini 3 Pro',
    family: 'Gemini 3',
    provider: 'Google',
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.125,
    quotaWeight: 1.0
  },
  'gpt-oss-120b': {
    label: 'GPT-OSS 120B (Medium)',
    family: 'GPT-OSS',
    provider: 'OpenAI',
    inputPer1M: 1.50,
    outputPer1M: 6.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.15,
    quotaWeight: 0.6
  },

  // OpenAI Codex / GPT-6 & GPT-5.6 Series
  'gpt-6-astra': {
    label: 'GPT-6-Astra',
    family: 'GPT-6',
    provider: 'OpenAI',
    inputPer1M: 5.0,
    outputPer1M: 20.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.50,
    quotaWeight: 2.0
  },
  'gpt-6.1-sol': {
    label: 'GPT-6.1-Sol',
    family: 'GPT-6.1',
    provider: 'OpenAI',
    inputPer1M: 2.50,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.25,
    quotaWeight: 1.0
  },
  'gpt-6.1-terra': {
    label: 'GPT-6.1 Terra',
    family: 'GPT-6.1',
    provider: 'OpenAI',
    inputPer1M: 2.00,
    outputPer1M: 8.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.20,
    quotaWeight: 0.8
  },
  'gpt-6-sol': {
    label: 'GPT-6-Sol',
    family: 'GPT-6',
    provider: 'OpenAI',
    inputPer1M: 2.00,
    outputPer1M: 8.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.20,
    quotaWeight: 0.8
  },
  'gpt-6-luna': {
    label: 'GPT-6-Luna',
    family: 'GPT-6',
    provider: 'OpenAI',
    inputPer1M: 0.80,
    outputPer1M: 3.20,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.08,
    quotaWeight: 0.35
  },
  'gpt-reserve': {
    label: 'GPT-Reserve',
    family: 'GPT-6',
    provider: 'OpenAI',
    inputPer1M: 0.60,
    outputPer1M: 2.40,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.06,
    quotaWeight: 0.25
  },
  'gpt-5.6-sol': {
    label: 'GPT-5.6-Sol',
    family: 'GPT-5.6',
    provider: 'OpenAI',
    inputPer1M: 1.50,
    outputPer1M: 6.00,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.15,
    quotaWeight: 0.6
  },
  'gpt-5.6-terra': {
    label: 'GPT-5.6-Terra',
    family: 'GPT-5.6',
    provider: 'OpenAI',
    inputPer1M: 1.25,
    outputPer1M: 5.00,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.125,
    quotaWeight: 0.5
  },
  'gpt-5.6-luna': {
    label: 'GPT-5.6-Luna',
    family: 'GPT-5.6',
    provider: 'OpenAI',
    inputPer1M: 0.40,
    outputPer1M: 1.60,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.04,
    quotaWeight: 0.2
  },
  'codex-auto-review': {
    label: 'Codex Auto Review',
    family: 'Codex',
    provider: 'OpenAI',
    inputPer1M: 0.40,
    outputPer1M: 1.60,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.04,
    quotaWeight: 0.2
  },
  'gpt-5': {
    label: 'GPT-5',
    family: 'GPT-5',
    provider: 'OpenAI',
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.125,
    quotaWeight: 0.8
  },
  'o3': {
    label: 'OpenAI o3',
    family: 'o-Series',
    provider: 'OpenAI',
    inputPer1M: 2.0,
    outputPer1M: 8.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.50,
    quotaWeight: 0.8
  },
  'o4-mini': {
    label: 'OpenAI o4-mini',
    family: 'o-Series',
    provider: 'OpenAI',
    inputPer1M: 1.10,
    outputPer1M: 4.40,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.275,
    quotaWeight: 0.4
  },
  'gpt-4o': {
    label: 'GPT-4o',
    family: 'GPT-4o',
    provider: 'OpenAI',
    inputPer1M: 2.50,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 1.25,
    quotaWeight: 1.0
  }
};

export const SUBSCRIPTION_PLANS = {
  gpt: {
    plus: {
      id: 'plus',
      name: 'ChatGPT Plus ($20/月)',
      monthlyPriceUsd: 20,
      fiveHourBudgetUsd: 45.0,
      sevenDayBudgetUsd: 315.0,
      fiveHourTurnsSoftCap: 160
    },
    team: {
      id: 'team',
      name: 'ChatGPT Team ($30/月)',
      monthlyPriceUsd: 30,
      fiveHourBudgetUsd: 90.0,
      sevenDayBudgetUsd: 630.0,
      fiveHourTurnsSoftCap: 320
    },
    pro: {
      id: 'pro',
      name: 'ChatGPT Pro ($200/月)',
      monthlyPriceUsd: 200,
      fiveHourBudgetUsd: 900.0,
      sevenDayBudgetUsd: 6300.0,
      fiveHourTurnsSoftCap: 3200
    }
  },
  claude: {
    pro: {
      id: 'pro',
      name: 'Claude Pro ($20/月)',
      monthlyPriceUsd: 20,
      fiveHourBudgetUsd: 67.5,
      sevenDayBudgetUsd: 470.0,
      fiveHourTurnsSoftCap: 120
    },
    team: {
      id: 'team',
      name: 'Claude Team ($30/月)',
      monthlyPriceUsd: 30,
      fiveHourBudgetUsd: 135.0,
      sevenDayBudgetUsd: 940.0,
      fiveHourTurnsSoftCap: 240
    },
    max5x: {
      id: 'max5x',
      name: 'Claude Max 5x ($100/月)',
      monthlyPriceUsd: 100,
      fiveHourBudgetUsd: 335.0,
      sevenDayBudgetUsd: 2350.0,
      fiveHourTurnsSoftCap: 600
    },
    max20x: {
      id: 'max20x',
      name: 'Claude Max 20x ($200/月)',
      monthlyPriceUsd: 200,
      fiveHourBudgetUsd: 1340.0,
      sevenDayBudgetUsd: 9400.0,
      fiveHourTurnsSoftCap: 2400
    }
  },
  antigravity: {
    pro: {
      id: 'pro',
      name: 'Google AI Pro ($20/月)',
      monthlyPriceUsd: 20,
      fiveHourBudgetUsd: 16.5,
      sevenDayBudgetUsd: 62.0,
      thirdParty5hBudgetUsd: 3.5,
      thirdParty7dBudgetUsd: 7.0,
      fiveHourTurnsSoftCap: 250
    },
    ultra5x: {
      id: 'ultra5x',
      name: 'Gemini Ultra 5x (g1-ultra-lite)',
      monthlyPriceUsd: 125,
      fiveHourBudgetUsd: 81.6,
      sevenDayBudgetUsd: 305.2,
      thirdParty5hBudgetUsd: 15.6,
      thirdParty7dBudgetUsd: 31.1,
      fiveHourTurnsSoftCap: 1200
    },
    ultra: {
      id: 'ultra',
      name: 'Google AI Ultra 20x ($250/月)',
      monthlyPriceUsd: 250,
      fiveHourBudgetUsd: 325.0,
      sevenDayBudgetUsd: 1220.0,
      thirdParty5hBudgetUsd: 62.0,
      thirdParty7dBudgetUsd: 124.0,
      fiveHourTurnsSoftCap: 4000
    }
  }
};

export function normalizeModelKey(rawModel = '') {
  const m = String(rawModel).trim().toLowerCase();
  if (!m || m === '<synthetic>') return 'unknown';

  // Anthropic Claude Family
  if (m.includes('fable') || m.includes('mythos')) {
    if (m.includes('5-1') || m.includes('5.1')) return 'claude-fable-5-1';
    return 'claude-fable-5-2';
  }

  if (m.includes('opus')) {
    if (m.includes('high')) return 'claude-opus-5-5-high';
    if (m.includes('low')) return 'claude-opus-5-5-low';
    if (m.includes('medium')) return 'claude-opus-5-5-medium';
    if (m.includes('opus-5-5') || m.includes('opus 5.5')) return 'claude-opus-5-5';
    return 'claude-opus-5';
  }

  if (m.includes('sonnet')) {
    if (m.includes('high')) return 'claude-sonnet-5-5-high';
    if (m.includes('low')) return 'claude-sonnet-5-5-low';
    if (m.includes('medium')) return 'claude-sonnet-5-5-medium';
    if (m.includes('sonnet-5-5') || m.includes('sonnet 5.5')) return 'claude-sonnet-5-5';
    return 'claude-sonnet-5';
  }

  if (m.includes('haiku')) return 'claude-haiku-5-5';
  if (m.includes('gpt-oss')) return 'gpt-oss-120b';

  // OpenAI Codex / GPT Family
  if (m.includes('gpt-6-astra') || m.includes('gpt-6 astra')) return 'gpt-6-astra';
  if (m.includes('gpt-6.1-sol') || m.includes('gpt-6.1 sol')) return 'gpt-6.1-sol';
  if (m.includes('gpt-6.1-terra') || m.includes('gpt-6.1 terra')) return 'gpt-6.1-terra';
  if (m.includes('gpt-6-sol') || m.includes('gpt-6 sol')) return 'gpt-6-sol';
  if (m.includes('gpt-6-luna') || m.includes('gpt-6 luna')) return 'gpt-6-luna';
  if (m.includes('gpt-reserve') || m.includes('gpt reserve')) return 'gpt-reserve';
  if (m.includes('gpt-5.6-sol') || m.includes('gpt-5.6 sol')) return 'gpt-5.6-sol';
  if (m.includes('gpt-5.6-terra') || m.includes('gpt-5.6 terra')) return 'gpt-5.6-terra';
  if (m.includes('gpt-5.6-luna') || m.includes('gpt-5.6 luna')) return 'gpt-5.6-luna';
  if (m.includes('codex-auto-review') || m.includes('auto-review')) return 'codex-auto-review';
  if (m.includes('o4-mini')) return 'o4-mini';
  if (m === 'o3' || m.startsWith('o3-')) return 'o3';
  if (m.includes('gpt-4o')) return 'gpt-4o';
  if (m.includes('gpt-5')) return 'gpt-5';
  if (m.includes('gpt')) return 'gpt-6.1-sol';

  // Google Flash Family
  if (m.includes('flash')) {
    if (m.includes('high')) return 'gemini-flash-high';
    if (m.includes('low')) return 'gemini-flash-low';
    if (m.includes('medium')) return 'gemini-flash-medium';
    return 'gemini-flash';
  }

  // Google Argon Family
  if (m.includes('argon')) {
    if (m.includes('low')) return 'gemini-4-argon-low';
    if (m.includes('medium')) return 'gemini-4-argon-medium';
    if (m.includes('high')) return 'gemini-4-argon-high';
    return 'gemini-4-argon';
  }

  if (m.includes('gemini 3') || m.includes('gemini-3')) {
    return 'gemini-3';
  }

  return m;
}

const RATE_FIELDS = ['inputPer1M', 'outputPer1M', 'cacheWritePer1M', 'cacheReadPer1M', 'quotaWeight'];

// Models missing from MODEL_PRICING (e.g. a freshly released "Gemini 4 Carbon") are resolved via the
// dynamic registry: manual override (data/model_overrides.json) > closest known sibling > default.
function getDynamicModelSpec(rawModel, timestamp) {
  const info = resolveUnknownModel(rawModel, Object.keys(MODEL_PRICING));
  if (!info) return null;

  const inherited = info.inheritFrom ? getModelSpec(info.inheritFrom, timestamp) : null;
  if (!inherited && !info.overrides) return null;

  const spec = {
    ...(inherited || { inputPer1M: 2.0, outputPer1M: 10.0, cacheWritePer1M: 0.0, cacheReadPer1M: 0.1, quotaWeight: 1.0 }),
    label: info.label,
    family: info.family,
    provider: info.provider
  };
  for (const f of RATE_FIELDS) {
    if (typeof info.overrides?.[f] === 'number') spec[f] = info.overrides[f];
  }
  spec.pricingTier = info.overrides ? 'custom' : 'estimated';
  spec.estimatedFrom = info.overrides ? null : info.inheritFrom;
  return spec;
}

export function isKnownModel(rawModel) {
  return Boolean(MODEL_PRICING[normalizeModelKey(rawModel)]);
}

export function getModelSpec(rawModel, timestamp = null) {
  const key = normalizeModelKey(rawModel);
  if (!MODEL_PRICING[key]) {
    const dyn = getDynamicModelSpec(rawModel, timestamp);
    if (dyn) return dyn;
  }
  const baseSpec = MODEL_PRICING[key] || {
    label: rawModel || 'Unknown Model',
    family: 'Other',
    provider: 'Unknown',
    inputPer1M: 2.00,
    outputPer1M: 10.0,
    cacheWritePer1M: 2.50,
    cacheReadPer1M: 0.10,
    quotaWeight: 1.0
  };

  let label = baseSpec.label;
  if (baseSpec.provider === 'OpenAI' && rawModel && !label.includes('(')) {
    const m = String(rawModel).toLowerCase();
    if (m.includes('xhigh')) label = `${label} (xHigh)`;
    else if (m.includes('high')) label = `${label} (High)`;
    else if (m.includes('medium')) label = `${label} (Medium)`;
    else if (m.includes('low')) label = `${label} (Low)`;
    else if (m.includes('minimal')) label = `${label} (Minimal)`;
  }

  // Dynamic pricing for Gemini 4 Argon:
  // Introductory price ($2 / $10 / $0.10) until 2026-11-30 23:59:59 UTC
  // Standard price ($4 / $20 / $0.20) starting 2026-12-01 00:00:00 UTC
  if (key.startsWith('gemini-4-argon')) {
    const tsMs = timestamp
      ? (typeof timestamp === 'number' ? timestamp : Date.parse(timestamp))
      : Date.now();
    const isStandard = !Number.isNaN(tsMs) && tsMs >= ARGON_STANDARD_START_MS;
    const rates = isStandard ? GEMINI_ARGON_RATES.standard : GEMINI_ARGON_RATES.intro;

    return {
      ...baseSpec,
      inputPer1M: rates.inputPer1M,
      outputPer1M: rates.outputPer1M,
      cacheWritePer1M: rates.cacheWritePer1M,
      cacheReadPer1M: rates.cacheReadPer1M,
      pricingTier: rates.tier
    };
  }

  return { ...baseSpec, label, pricingTier: 'standard' };
}

export function calculateTurnCost({
  model,
  inputTokens = 0,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
  outputTokens = 0,
  thinkingTokens = 0,
  timestamp = null
}) {
  const spec = getModelSpec(model, timestamp);

  const inputCost = (inputTokens / 1_000_000) * spec.inputPer1M;
  const cacheWriteCost = (cacheCreationTokens / 1_000_000) * spec.cacheWritePer1M;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * spec.cacheReadPer1M;
  const outputCost = (outputTokens / 1_000_000) * spec.outputPer1M;

  // Thinking tokens are already part of outputTokens and billed at the same outputPer1M rate
  const thinkingCost = (thinkingTokens / 1_000_000) * spec.outputPer1M;

  const totalCostUsd = inputCost + cacheWriteCost + cacheReadCost + outputCost;
  const uncachedEquivalentUsd =
    ((inputTokens + cacheReadTokens + cacheCreationTokens) / 1_000_000) * spec.inputPer1M + outputCost;
  const cacheSavingsUsd = Math.max(0, uncachedEquivalentUsd - totalCostUsd);

  return {
    totalCostUsd,
    uncachedEquivalentUsd,
    cacheSavingsUsd,
    inputCost,
    cacheWriteCost,
    cacheReadCost,
    outputCost,
    thinkingCost,
    modelLabel: spec.label,
    modelFamily: spec.family,
    pricingTier: spec.pricingTier || 'standard'
  };
}
