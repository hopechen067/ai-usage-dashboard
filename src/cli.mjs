#!/usr/bin/env node
import {
  getDashboardSnapshot,
  fetchAntigravityOfficialQuota,
  getModelRegistrySummary,
  getQuotaResetsState,
  triggerManualQuotaReset,
  revertManualQuotaReset
} from './collector.mjs';
import { MODEL_REGISTRY_PATHS } from './model-registry.mjs';

// `node src/cli.mjs models` : sync the live model list from Antigravity & show how each model is priced
if (process.argv[2] === 'models') {
  const live = await fetchAntigravityOfficialQuota();
  if (!live) console.log('[提示] 未能连接到运行中的 Antigravity language_server，仅显示已缓存的模型列表。');
  // Prime transcript-based discovery too (also refreshes the registry)
  await getDashboardSnapshot({ days: 1 });
  const summary = getModelRegistrySummary();
  console.log(`\n模型注册表更新时间: ${summary.updatedAt || '—'}`);
  console.log(`文件: ${MODEL_REGISTRY_PATHS.REGISTRY_FILE}`);
  console.log(`手动定价覆盖(可选): ${MODEL_REGISTRY_PATHS.OVERRIDES_FILE}\n`);
  const pricingText = { builtin: '内置定价', inherited: '继承估价', override: '手动覆盖', default: '默认估价' };
  for (const m of summary.models) {
    const from = m.inheritFrom ? ` ← ${m.inheritFrom}` : '';
    console.log(
      `  ${m.label.padEnd(32)} ${m.provider.padEnd(10)} ${m.source.padEnd(20)} ${(pricingText[m.pricing] || m.pricing)}${from}`
    );
  }
  console.log('');
  process.exit(0);
}

// `node src/cli.mjs resets` : show weekly quota reset state across all 4 pools
if (process.argv[2] === 'resets') {
  const resets = getQuotaResetsState();
  const modeLabel = { in_cycle: '周内重置(自然时间不变)', recalculate: '完全重置(重算自然时间)', natural: '自然周期' };
  console.log('\n=== 周额度重置状态 (data/quota_resets.json) ===');
  for (const [pool, info] of Object.entries(resets)) {
    const ov = info.activeOverride;
    const status = ov
      ? `${modeLabel[ov.mode] || ov.mode} [${ov.source}] | 起算: ${ov.cycleStartAt} | 自然重置: ${ov.naturalResetsAt}`
      : '自然周期 (无活动重置覆盖)';
    console.log(`  • ${pool.padEnd(11)} : ${status}`);
    for (const ev of (info.events || []).slice(0, 3)) {
      console.log(`      - ${ev.resetAt} | ${modeLabel[ev.mode] || ev.mode} (${ev.source}) | 前段 ${ev.prevUsedPct ?? 0}% | ${ev.note || ''}`);
    }
  }
  console.log('');
  process.exit(0);
}

// `node src/cli.mjs reset <pool> <in_cycle|recalculate|revert> [resetAt]`
if (process.argv[2] === 'reset') {
  const pool = process.argv[3];
  const mode = process.argv[4];
  const resetAt = process.argv[5] || null;
  if (!pool || !mode) {
    console.error('用法: node src/cli.mjs reset <claude|gpt|agy-gemini|agy-tp> <in_cycle|recalculate|revert> [ISO时间]');
    process.exit(1);
  }
  if (mode === 'revert') {
    const res = revertManualQuotaReset({ pool });
    console.log(res.reverted ? `已撤销 ${pool} 的手动重置覆盖 (${res.revertedEventId})` : res.message);
    process.exit(0);
  }
  const res = await triggerManualQuotaReset({ pool, mode, resetAt });
  const sd = res.sevenDay;
  const label = mode === 'in_cycle' ? '周内重置(保留原自然重置时间)' : '完全重置(已重新计算自然重置时间)';
  console.log(`\n[周额度重置成功] ${pool} -> ${label}`);
  console.log(`  ├─ 新起算时间   : ${sd.cycleStartAt}`);
  console.log(`  ├─ 自然重置时间 : ${sd.resetsAt || '—'}`);
  console.log(`  └─ 重算后已用   : ${sd.usedPercentage}% (剩余 ${sd.remainingPercentage}%) | ${sd.turns} 轮 | $${sd.costUsd.toFixed(2)}\n`);
  process.exit(0);
}

const daysArg = process.argv[2] || '30';
const snap = await getDashboardSnapshot({ days: daysArg === 'all' ? 'all' : Number(daysArg) });

const fmtTok = n => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

console.log(`\n======================================================================`);
console.log(`  Claude Code & Antigravity 全局订阅与使用量统计 (${daysArg === 'all' ? '全部历史' : daysArg === 'today' ? '今日 (当天)' : `近 ${daysArg} 天`})`);
console.log(`  扫描耗时: ${snap.scanDurationMs} ms | 生成时间: ${new Date(snap.generatedAt).toLocaleString()}`);
console.log(`======================================================================\n`);

if (snap.todayStats) {
  const ts = snap.todayStats;
  const cTps = ts.claude.avgTps > 0 ? ` | ⚡ ${ts.claude.avgTps} tok/s (峰值 ${ts.claude.peakTps})` : '';
  const aTps = ts.antigravity.avgTps > 0 ? ` | ⚡ ${ts.antigravity.avgTps} tok/s` : '';
  console.log(`[🌞 今日实时统计 (${ts.date})]`);
  console.log(
    `  ├─ 今日总计       : $${ts.combined.costUsd.toFixed(2)} | ${ts.combined.turns} 轮 (${ts.combined.sessions} 会话) | ${fmtTok(ts.combined.totalTokens)} tokens | 缓存省 $${ts.combined.cacheSavingsUsd.toFixed(2)}`
  );
  console.log(
    `  ├─ 今日 Claude    : $${ts.claude.costUsd.toFixed(2)} | ${ts.claude.turns} 轮 (${ts.claude.sessions} 会话) | ${fmtTok(ts.claude.totalTokens)} tokens${cTps}`
  );
  const extSuffix =
    ts.antigravity.externalApiTurns > 0
      ? ` · Vertex/API ${ts.antigravity.externalApiTurns}轮 ($${ts.antigravity.externalApiCostUsd.toFixed(2)})`
      : '';
  console.log(
    `  └─ 今日 Antigravity: $${ts.antigravity.costUsd.toFixed(2)} | ${ts.antigravity.turns} 轮 (${ts.antigravity.sessions} 会话) | Gemini ${ts.antigravity.geminiTurns}轮 ($${ts.antigravity.geminiCostUsd.toFixed(2)}) · 第三方 ${ts.antigravity.thirdPartyTurns}轮 ($${ts.antigravity.thirdPartyCostUsd.toFixed(2)})${extSuffix}${aTps}\n`
  );
}

const fmtResetTag = sd => {
  const ri = sd?.resetInfo;
  if (!ri || ri.mode === 'natural') return '';
  const tag = ri.mode === 'in_cycle' ? '周内重置·自然时间不变' : '完全重置·重算自然时间';
  const startStr = ri.effectiveCycleStartAt ? new Date(ri.effectiveCycleStartAt).toLocaleString() : '';
  return ` [${tag}${startStr ? ` @ ${startStr}` : ''}]`;
};

for (const key of ['claude', 'gpt', 'antigravity']) {
  const q = snap.quotaStatus[key];
  if (!q) continue;
  const label = key === 'claude' ? 'Claude Code / Desktop' : key === 'gpt' ? 'OpenAI Codex / GPT' : 'Google Antigravity';
  console.log(`[${label}] 套餐: ${q.planName} (${q.quotaSourceLabel})`);
  console.log(
    `  ├─ 5小时滚动配额: 已用 ${q.fiveHour.usedPercentage}% (剩余 ${q.fiveHour.remainingPercentage}%) | ${q.fiveHour.turns} 轮 | ${fmtTok(q.fiveHour.totalTokens)} tokens | 等价 $${q.fiveHour.costUsd.toFixed(2)} / ~$${q.fiveHourBudgetUsd}`
  );
  console.log(
    `  ├─ 7天滚动配额  : 已用 ${q.sevenDay.usedPercentage}% (剩余 ${q.sevenDay.remainingPercentage}%) | ${q.sevenDay.turns} 轮 | ${fmtTok(q.sevenDay.totalTokens)} tokens | 等价 $${q.sevenDay.costUsd.toFixed(2)} / ~$${q.sevenDayBudgetUsd}${fmtResetTag(q.sevenDay)}`
  );
  if (q.thirdParty) {
    const tp = q.thirdParty;
    console.log(
      `  ├─ [第三方 Claude & GPT 5h] : 已用 ${tp.fiveHour.usedPercentage}% (面板剩余 ${tp.fiveHour.nativeRemainingPct}%) | ${tp.fiveHour.turns} 轮 | ${fmtTok(tp.fiveHour.totalTokens)} tokens | 等价 $${tp.fiveHour.costUsd.toFixed(2)} / ~$${tp.fiveHourBudgetUsd}`
    );
    console.log(
      `  ├─ [第三方 Claude & GPT 7d] : 已用 ${tp.sevenDay.usedPercentage}% (面板剩余 ${tp.sevenDay.nativeRemainingPct}%) | ${tp.sevenDay.turns} 轮 | ${fmtTok(tp.sevenDay.totalTokens)} tokens | 等价 $${tp.sevenDay.costUsd.toFixed(2)} / ~$${tp.sevenDayBudgetUsd}${fmtResetTag(tp.sevenDay)}`
    );
  }
  if (q.externalApi?.sevenDay?.turns > 0) {
    const ext = q.externalApi;
    console.log(
      `  ├─ [Vertex AI / API 已排除出订阅配额] : 7天 ${ext.sevenDay.turns} 轮 ($${ext.sevenDay.costUsd.toFixed(2)}) | 30天 ${ext.thirtyDay.turns} 轮 ($${ext.thirtyDay.costUsd.toFixed(2)})`
    );
  }
  console.log(
    `  └─ 30天订阅回本率: ${q.thirtyDay.roiPercentage}% (${q.thirtyDay.roiMultiplier}x) — 已用出 $${q.thirtyDay.costUsd.toFixed(2)} 等价 API 价值 (缓存省 $${q.thirtyDay.cacheSavingsUsd.toFixed(2)})\n`
  );
}

console.log(`--- 模型消耗明细 ---`);
for (const m of snap.models) {
  const tpsStr = m.avgTps > 0 ? `${String(m.avgTps).padStart(5)} tok/s (峰 ${String(m.peakTps).padStart(5)})` : `   -- tok/s           `;
  const srcTag = m.isExternalApi ? '[API] ' : '';
  console.log(
    `  • [${m.platform.toUpperCase()}] ${srcTag}${m.model.padEnd(24)} | ${String(m.turns).padStart(5)} 轮 | 总计 ${fmtTok(m.totalTokens).padStart(8)} (缓存命中 ${m.cacheHitRate}%) | 速率 ${tpsStr} | 等价 $${m.costUsd.toFixed(2).padStart(7)} (${m.sharePct}%)`
  );
}
console.log('');
