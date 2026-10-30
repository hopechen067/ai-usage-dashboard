#!/usr/bin/env node
// Lightweight receiver for Claude Code statusLine & Antigravity lifecycle hooks
import fs from 'node:fs';
import { saveLiveQuota } from './collector.mjs';

const mode = process.argv[2] || '--auto';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.stdout.write('{}');
      return;
    }
    const payload = JSON.parse(raw);

    // Detect Claude Code statusLine payload
    if (mode === '--claude-statusline' || payload.rate_limits || payload.context_window) {
      const fiveHour = payload.rate_limits?.five_hour
        ? {
            usedPercentage: payload.rate_limits.five_hour.used_percentage,
            resetsAt: payload.rate_limits.five_hour.resets_at
          }
        : null;
      const sevenDay = payload.rate_limits?.seven_day
        ? {
            usedPercentage: payload.rate_limits.seven_day.used_percentage,
            resetsAt: payload.rate_limits.seven_day.resets_at
          }
        : null;

      saveLiveQuota('claude', {
        fiveHour,
        sevenDay,
        sessionCostUsd: payload.cost?.total_cost_usd ?? null,
        activeModel: payload.model?.display_name || payload.model?.id || null
      });

      const modelName = payload.model?.display_name || payload.model?.id || 'Claude';
      const costStr = payload.cost?.total_cost_usd != null ? `$${Number(payload.cost.total_cost_usd).toFixed(3)}` : '';
      const pct5h = fiveHour?.usedPercentage != null ? `5h:${fiveHour.usedPercentage.toFixed(0)}%` : '';
      const pct7d = sevenDay?.usedPercentage != null ? `7d:${sevenDay.usedPercentage.toFixed(0)}%` : '';
      const parts = [modelName, pct5h, pct7d, costStr].filter(Boolean);
      process.stdout.write(parts.join(' | '));
      return;
    }

    // Detect Antigravity Hook payload (camelCase fields: conversationId, modelName, terminationReason)
    if (mode === '--agy-hook' || payload.conversationId) {
      const hitCap = payload.terminationReason === 'MAX_TOKEN_BUDGET_EXCEEDED';
      saveLiveQuota('antigravity', {
        activeModel: payload.modelName || null,
        lastConversationId: payload.conversationId || null,
        hitTokenBudgetExceeded: hitCap
      });
      process.stdout.write('{}');
      return;
    }

    process.stdout.write('{}');
  } catch {
    process.stdout.write('{}');
  }
}

main();
