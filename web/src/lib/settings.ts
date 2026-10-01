import { z } from 'zod';
import { json, sql, type Q } from './db';
import { env } from './env';

export const TIERS = ['fast', 'standard', 'advanced'] as const;
export const TASKS = [
  'simple_question', 'short_reply', 'email', 'classify',
  'file_analysis', 'fill_blank', 'web_search',
  'generate', 'complex_reasoning',
] as const;

const tier = z.enum(TIERS);
const tierCfg = z.object({ model_id: z.string().min(1).max(300), enabled: z.boolean() });

export const routingSchema = z.object({
  tiers: z.object({ fast: tierCfg, standard: tierCfg, advanced: tierCfg }),
  tasks: z.record(z.string().min(1).max(64), tier),
  overrides: z.record(z.string().min(1).max(64), tier).default({}),
  escalate_when_unsure: z.boolean(),
});
export type Routing = z.infer<typeof routingSchema>;

const price = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  cache_read: z.number().min(0),
  cache_write: z.number().min(0),
});
export const pricesSchema = z.object({
  models: z.record(z.string().min(1).max(300), price),
  web_search_unit_usd: z.number().min(0),
});
export type Prices = z.infer<typeof pricesSchema>;

export const budgetSchema = z.object({
  monthly_usd: z.number().min(0),
  alert_pct: z.number().int().min(1).max(100).default(80),
  over_action: z.enum(['pause', 'fast_only', 'warn']),
});
export type Budget = z.infer<typeof budgetSchema>;

export function defaultRouting(): Routing {
  return {
    tiers: {
      fast: { model_id: env.modelFast(), enabled: true },
      standard: { model_id: env.modelStandard(), enabled: true },
      advanced: { model_id: env.modelAdvanced(), enabled: true },
    },
    tasks: {
      simple_question: 'fast', short_reply: 'fast', email: 'fast', classify: 'fast',
      file_analysis: 'standard', fill_blank: 'standard', web_search: 'standard',
      generate: 'advanced', complex_reasoning: 'advanced',
    },
    overrides: {},
    escalate_when_unsure: true,
  };
}

/** $ per 1M tokens: AWS Bedrock on-demand, eu-north-1, eu.* profiles at the regional rate (price list, 2026-10-01).
 *  Keep in step with DEFAULT_MODEL_PRICES in worker/app/llm/config_store.py, which the usage ledger bills with. */
export function defaultPrices(): Prices {
  return {
    models: {
      [env.modelFast()]: { input: 1.1, output: 5.5, cache_read: 0.11, cache_write: 1.375 },
      [env.modelStandard()]: { input: 3.3, output: 16.5, cache_read: 0.33, cache_write: 4.125 },
      [env.modelAdvanced()]: { input: 5.5, output: 27.5, cache_read: 0.55, cache_write: 6.875 },
    },
    web_search_unit_usd: Number(process.env.WEB_SEARCH_UNIT_COST_USD || 0.005),
  };
}

export function defaultBudget(): Budget {
  return { monthly_usd: 0, alert_pct: 80, over_action: 'warn' };
}

export async function getSetting<T>(key: string, fallback: () => T, q: Q = sql): Promise<{ value: T; is_default: boolean; updated_at: Date | null }> {
  const rows = await q<{ value: T; updated_at: Date }[]>`SELECT value, updated_at FROM settings WHERE key = ${key}`;
  if (!rows[0]) return { value: fallback(), is_default: true, updated_at: null };
  return { value: rows[0].value, is_default: false, updated_at: rows[0].updated_at };
}

export async function putSetting(key: string, value: unknown, userId: string, q: Q = sql): Promise<void> {
  await q`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (${key}, ${json(value)}, ${userId}, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export interface BudgetStatus {
  spent_usd: number;
  amount_usd: number;
  alert_pct: number;
  action: 'pause' | 'fast_only' | 'warn';
  state: 'ok' | 'near' | 'over';
}

export async function budgetStatus(q: Q = sql): Promise<BudgetStatus> {
  const rows = await q<BudgetStatus[]>`SELECT * FROM budget_status()`;
  return rows[0];
}

const usd = (n: number) => `$${n.toFixed(2)}`;
export function budgetMessage(b: BudgetStatus): string | null {
  if (b.state === 'ok') return null;
  if (b.state === 'near') {
    const pct = b.amount_usd > 0 ? Math.round((b.spent_usd / b.amount_usd) * 100) : 0;
    return `${pct}% of this month's ${usd(b.amount_usd)} budget is used.`;
  }
  if (b.action === 'pause') {
    return `This month's ${usd(b.amount_usd)} budget is used up. Chat is paused until next month or until an admin raises the budget.`;
  }
  if (b.action === 'fast_only') {
    return `This month's ${usd(b.amount_usd)} budget is used up. Only the fast model is used until next month.`;
  }
  return `This month's ${usd(b.amount_usd)} budget is exceeded (${usd(b.spent_usd)} spent).`;
}
