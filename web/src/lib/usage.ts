import { sql } from './db';
import type { SessionUser } from './auth/session';

/**
 * Usage dashboard, entirely from the `usage` ledger (plus messages.cost_usd for "avg per question").
 * Estimators see only their own usage/conversations; admins see everyone.
 */
export async function usageReport(user: SessionUser, days: number) {
  const all = user.role === 'admin';
  const uid = user.id;
  const scope = (alias: string) => (all ? sql`true` : sql`${sql(alias)}.user_id = ${uid}`);
  const since = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${days - 1})) AT TIME ZONE 'UTC'`;
  const monthStart = sql`date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;

  const [kpi, avgQ, tiers, daily, top, perConv] = await Promise.all([
    sql`SELECT
          COALESCE(sum(cost_usd) FILTER (WHERE created_at >= ${monthStart}), 0)::float8 AS spend_month_usd,
          COALESCE(sum(cost_usd) FILTER (WHERE created_at >= ${since}), 0)::float8 AS spend_period_usd,
          count(DISTINCT run_id) FILTER (WHERE created_at >= ${since})::int AS runs
        FROM usage u WHERE ${scope('u')}`,
    sql`SELECT COALESCE(avg(m.cost_usd), 0)::float8 AS avg_cost_per_question, count(*)::int AS questions
          FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE m.role = 'assistant' AND m.cost_usd IS NOT NULL AND m.created_at >= ${since} AND ${scope('c')}`,
    sql`SELECT COALESCE(tier, 'other') AS tier, count(*)::int AS calls,
               COALESCE(sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0)::bigint AS tokens,
               COALESCE(sum(input_tokens), 0)::bigint AS input_tokens, COALESCE(sum(output_tokens), 0)::bigint AS output_tokens,
               COALESCE(sum(cost_usd), 0)::float8 AS cost_usd
          FROM usage u WHERE created_at >= ${since} AND ${scope('u')}
         GROUP BY 1 ORDER BY 1`,
    sql`WITH d AS (
          SELECT generate_series(date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${days - 1}),
                                 date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day')::date AS day)
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
               COALESCE(sum(u.cost_usd) FILTER (WHERE u.tier = 'fast'), 0)::float8 AS fast,
               COALESCE(sum(u.cost_usd) FILTER (WHERE u.tier = 'standard'), 0)::float8 AS standard,
               COALESCE(sum(u.cost_usd) FILTER (WHERE u.tier = 'advanced'), 0)::float8 AS advanced,
               COALESCE(sum(u.cost_usd) FILTER (WHERE u.tier IS NULL OR u.tier NOT IN ('fast','standard','advanced')), 0)::float8 AS other,
               COALESCE(sum(u.cost_usd), 0)::float8 AS total
          FROM d LEFT JOIN usage u ON (u.created_at AT TIME ZONE 'UTC')::date = d.day AND ${scope('u')}
         GROUP BY d.day ORDER BY d.day`,
    sql`SELECT c.id, c.title, us.name AS user_name, sum(u.cost_usd)::float8 AS cost_usd
          FROM usage u JOIN conversations c ON c.id = u.conversation_id LEFT JOIN users us ON us.id = c.user_id
         WHERE u.created_at >= ${since} AND ${scope('c')}
         GROUP BY c.id, c.title, us.name ORDER BY sum(u.cost_usd) DESC LIMIT 5`,
    sql`SELECT c.id, c.title, c.user_id, us.name AS user_name, us.email::text AS user_email,
               count(DISTINCT u.run_id)::int AS runs,
               COALESCE(sum(u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens), 0)::bigint AS tokens,
               COALESCE(sum(u.cost_usd), 0)::float8 AS cost_usd,
               max(u.created_at) AS last_activity_at
          FROM usage u JOIN conversations c ON c.id = u.conversation_id LEFT JOIN users us ON us.id = c.user_id
         WHERE u.created_at >= ${since} AND ${scope('c')}
         GROUP BY c.id, c.title, c.user_id, us.name, us.email ORDER BY max(u.created_at) DESC LIMIT 500`,
  ]);

  const periodTotal = tiers.reduce((a, t) => a + Number(t.cost_usd), 0);
  const tierShare = Object.fromEntries(
    tiers.map((t) => [t.tier as string, periodTotal > 0 ? Number(t.cost_usd) / periodTotal : 0]),
  );
  return {
    days,
    scope: all ? 'all' : 'mine',
    kpis: {
      spend_month_usd: kpi[0].spend_month_usd,
      spend_period_usd: kpi[0].spend_period_usd,
      runs: kpi[0].runs,
      avg_cost_per_question_usd: avgQ[0].avg_cost_per_question,
      questions: avgQ[0].questions,
      tier_share: tierShare,
    },
    daily,
    tiers,
    top_conversations: top,
    conversations: all ? perConv : perConv.map(({ user_email: _e, ...r }) => r),
  };
}

export async function composerHint() {
  const r = (await sql<{ avg: number | null; n: number }[]>`
    SELECT avg(cost_usd)::float8 AS avg, count(*)::int AS n FROM (
      SELECT cost_usd FROM messages WHERE role = 'assistant' AND cost_usd IS NOT NULL
       ORDER BY created_at DESC LIMIT 50) t`)[0];
  const avg = r.avg ?? 0;
  let text = 'Auto model';
  if (r.n > 0) text += avg < 0.01 ? ' · under $0.01 per question' : ` · about $${avg.toFixed(2)} per question`;
  return { avg_usd: r.n > 0 ? avg : null, sample: r.n, text };
}
