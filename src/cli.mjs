#!/usr/bin/env node
import { getDashboardSnapshot } from './collector.mjs';

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
  console.log(`[🌞 今日实时统计 (${ts.date})]`);
  console.log(
    `  ├─ 今日总计       : $${ts.combined.costUsd.toFixed(2)} | ${ts.combined.turns} 轮 (${ts.combined.sessions} 会话) | ${fmtTok(ts.combined.totalTokens)} tokens | 缓存省 $${ts.combined.cacheSavingsUsd.toFixed(2)}`
  );
  console.log(
    `  ├─ 今日 Claude    : $${ts.claude.costUsd.toFixed(2)} | ${ts.claude.turns} 轮 (${ts.claude.sessions} 会话) | ${fmtTok(ts.claude.totalTokens)} tokens`
  );
  console.log(
    `  └─ 今日 Antigravity: $${ts.antigravity.costUsd.toFixed(2)} | ${ts.antigravity.turns} 轮 (${ts.antigravity.sessions} 会话) | Gemini ${ts.antigravity.geminiTurns}轮 ($${ts.antigravity.geminiCostUsd.toFixed(2)}) · 第三方 ${ts.antigravity.thirdPartyTurns}轮 ($${ts.antigravity.thirdPartyCostUsd.toFixed(2)})\n`
  );
}

for (const key of ['claude', 'antigravity']) {
  const q = snap.quotaStatus[key];
  const label = key === 'claude' ? 'Claude Code / Desktop' : 'Google Antigravity';
  console.log(`[${label}] 套餐: ${q.planName} (${q.quotaSourceLabel})`);
  console.log(
    `  ├─ 5小时滚动配额: 已用 ${q.fiveHour.usedPercentage}% (剩余 ${q.fiveHour.remainingPercentage}%) | ${q.fiveHour.turns} 轮 | ${fmtTok(q.fiveHour.totalTokens)} tokens | 等价 $${q.fiveHour.costUsd.toFixed(2)} / ~$${q.fiveHourBudgetUsd}`
  );
  console.log(
    `  ├─ 7天滚动配额  : 已用 ${q.sevenDay.usedPercentage}% (剩余 ${q.sevenDay.remainingPercentage}%) | ${q.sevenDay.turns} 轮 | ${fmtTok(q.sevenDay.totalTokens)} tokens | 等价 $${q.sevenDay.costUsd.toFixed(2)} / ~$${q.sevenDayBudgetUsd}`
  );
  if (q.thirdParty) {
    const tp = q.thirdParty;
    console.log(
      `  ├─ [第三方 Claude & GPT 5h] : 已用 ${tp.fiveHour.usedPercentage}% (面板剩余 ${tp.fiveHour.nativeRemainingPct}%) | ${tp.fiveHour.turns} 轮 | ${fmtTok(tp.fiveHour.totalTokens)} tokens | 等价 $${tp.fiveHour.costUsd.toFixed(2)} / ~$${tp.fiveHourBudgetUsd}`
    );
    console.log(
      `  ├─ [第三方 Claude & GPT 7d] : 已用 ${tp.sevenDay.usedPercentage}% (面板剩余 ${tp.sevenDay.nativeRemainingPct}%) | ${tp.sevenDay.turns} 轮 | ${fmtTok(tp.sevenDay.totalTokens)} tokens | 等价 $${tp.sevenDay.costUsd.toFixed(2)} / ~$${tp.sevenDayBudgetUsd}`
    );
  }
  console.log(
    `  └─ 30天订阅回本率: ${q.thirtyDay.roiPercentage}% (${q.thirtyDay.roiMultiplier}x) — 已用出 $${q.thirtyDay.costUsd.toFixed(2)} 等价 API 价值 (缓存省 $${q.thirtyDay.cacheSavingsUsd.toFixed(2)})\n`
  );
}

console.log(`--- 模型消耗明细 ---`);
for (const m of snap.models) {
  console.log(
    `  • [${m.platform.toUpperCase()}] ${m.model.padEnd(24)} | ${String(m.turns).padStart(5)} 轮 | 总计 ${fmtTok(m.totalTokens).padStart(8)} (缓存命中 ${m.cacheHitRate}%) | 等价 $${m.costUsd.toFixed(2).padStart(7)} (${m.sharePct}%)`
  );
}
console.log('');
