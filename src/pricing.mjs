// Model pricing & Subscription Quota estimation engine
// Prices are in USD per 1M tokens (API-equivalent value for subscription ROI & quota weighting)

export const PRICING_VERSION = 3;

export const MODEL_PRICING = {
  // Claude 5.5 / 4.5 / 4.6 family (Official Anthropic Opus 4.5/5.5 pricing: $5 / $25 per 1M)
  'claude-opus-5-5': {
    label: 'Claude Opus 5.5',
    family: 'Claude Opus',
    provider: 'Anthropic',
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheWritePer1M: 6.25,
    cacheReadPer1M: 0.50,
    quotaWeight: 1.67
  },
  'claude-opus-5': {
    label: 'Claude Opus 5',
    family: 'Claude Opus',
    provider: 'Anthropic',
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheWritePer1M: 6.25,
    cacheReadPer1M: 0.50,
    quotaWeight: 1.67
  },
  'claude-fable-5-1': {
    label: 'Claude Fable 5.1',
    family: 'Claude Fable',
    provider: 'Anthropic',
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheWritePer1M: 6.25,
    cacheReadPer1M: 0.50,
    quotaWeight: 1.67
  },
  'claude-sonnet-5-5': {
    label: 'Claude Sonnet 5.5',
    family: 'Claude Sonnet',
    provider: 'Anthropic',
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.30,
    quotaWeight: 1.0
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
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5',
    family: 'Claude Haiku',
    provider: 'Anthropic',
    inputPer1M: 0.80,
    outputPer1M: 4.0,
    cacheWritePer1M: 1.0,
    cacheReadPer1M: 0.08,
    quotaWeight: 0.25
  },
  // Gemini / Antigravity models
  'gemini-4-argon-high': {
    label: 'Gemini 4 Argon (High)',
    family: 'Gemini 4 Argon',
    provider: 'Google',
    inputPer1M: 2.50,
    outputPer1M: 15.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.25,
    quotaWeight: 1.2
  },
  'gemini-4-argon-medium': {
    label: 'Gemini 4 Argon (Medium)',
    family: 'Gemini 4 Argon',
    provider: 'Google',
    inputPer1M: 1.50,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.15,
    quotaWeight: 0.8
  },
  'gemini-4-argon-low': {
    label: 'Gemini 4 Argon (Low)',
    family: 'Gemini 4 Argon',
    provider: 'Google',
    inputPer1M: 0.80,
    outputPer1M: 5.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.08,
    quotaWeight: 0.4
  },
  'gemini-3': {
    label: 'Gemini 3 Pro',
    family: 'Gemini 3',
    provider: 'Google',
    inputPer1M: 1.25,
    outputPer1M: 10.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.125,
    quotaWeight: 0.7
  },
  'gemini-flash': {
    label: 'Gemini 3.8 Flash',
    family: 'Gemini Flash',
    provider: 'Google',
    inputPer1M: 0.30,
    outputPer1M: 2.50,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.03,
    quotaWeight: 0.2
  },
  'gpt-oss-120b': {
    label: 'GPT-OSS 120B (Medium)',
    family: 'GPT-OSS',
    provider: 'OpenAI',
    inputPer1M: 1.50,
    outputPer1M: 6.0,
    cacheWritePer1M: 0.0,
    cacheReadPer1M: 0.15,
    quotaWeight: 0.5
  }
};

export const SUBSCRIPTION_PLANS = {
  claude: {
    pro: {
      id: 'pro',
      name: 'Claude Pro ($20/月)',
      monthlyPriceUsd: 20,
      fiveHourBudgetUsd: 67.5,
      sevenDayBudgetUsd: 470.0,
      fiveHourTurnsSoftCap: 120
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
  if (m.includes('fable') || m.includes('mythos')) return 'claude-fable-5-1';
  if (m.includes('opus-5-5') || m.includes('opus 5.5')) return 'claude-opus-5-5';
  if (m.includes('opus')) return 'claude-opus-5';
  if (m.includes('sonnet-5-5') || m.includes('sonnet 5.5')) return 'claude-sonnet-5-5';
  if (m.includes('sonnet')) return 'claude-sonnet-5';
  if (m.includes('haiku')) return 'claude-haiku-5-5';
  if (m.includes('gpt-oss') || m.includes('gpt')) return 'gpt-oss-120b';
  if (m.includes('argon') && m.includes('low')) return 'gemini-4-argon-low';
  if (m.includes('argon') && m.includes('medium')) return 'gemini-4-argon-medium';
  if (m.includes('argon')) return 'gemini-4-argon-high';
  if (m.includes('gemini 3') || m.includes('gemini-3')) {
    if (m.includes('flash')) return 'gemini-flash';
    return 'gemini-3';
  }
  if (m.includes('flash')) return 'gemini-flash';
  return m;
}

export function getModelSpec(rawModel) {
  const key = normalizeModelKey(rawModel);
  return MODEL_PRICING[key] || {
    label: rawModel || 'Unknown Model',
    family: 'Other',
    provider: 'Unknown',
    inputPer1M: 2.50,
    outputPer1M: 12.0,
    cacheWritePer1M: 3.0,
    cacheReadPer1M: 0.25,
    quotaWeight: 1.0
  };
}

export function calculateTurnCost({
  model,
  inputTokens = 0,
  cacheCreationTokens = 0,
  cacheReadTokens = 0,
  outputTokens = 0
}) {
  const spec = getModelSpec(model);
  const inputCost = (inputTokens / 1_000_000) * spec.inputPer1M;
  const cacheWriteCost = (cacheCreationTokens / 1_000_000) * spec.cacheWritePer1M;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * spec.cacheReadPer1M;
  const outputCost = (outputTokens / 1_000_000) * spec.outputPer1M;

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
    modelLabel: spec.label,
    modelFamily: spec.family
  };
}
