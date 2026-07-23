import { complete, selectProvider } from '../core/llm.ts';
import {
  loadDecisions,
  loadLessons,
  paths,
  saveLessons,
  writeJson,
} from '../core/memory.ts';
import type { Decision, Lesson, LessonsFile } from '../types.ts';

const MIN_CLOSED_TRADES = 5;
const MAX_RULES = 8;
const TRADE_WINDOW = 100;
const BLOCK_WINDOW = 50;

const INDICATORS = [
  'price',
  'rsi14',
  'atrPct',
  'ema20',
  'ema50',
  'emaSpreadPct',
  'volumeRatio',
] as const;

const SYSTEM_PROMPT = `You are the risk analyst for an autonomous ETH/USDT spot grid trading bot.

The strategy ladders buy orders down a fixed price grid and never cuts losses: when
price falls, it buys another level; a lot is only ever sold above its entry. You may
NOT propose stop losses, loss exits, position sizing changes, or grid reconfiguration.
The only two controls you have are:

  block_entry  - refuse to place new buy orders while the condition holds
  hold_sell    - keep a lot past its normal +1-grid target while the condition holds

You are given the current rule set and a log of closed trades, each carrying the
indicator snapshot taken when the entry was placed. Output a COMPLETE REPLACEMENT
rule set — anything you omit is deleted.

Rules for revising:
- Keep rules the data still supports. Drop rules whose supporting evidence is gone.
- Propose a new rule only when at least 5 trades show a clear pattern. A coincidence
  is not a lesson. Two or three losers in a row is noise.
- Maximum ${MAX_RULES} rules. If you would exceed that, merge or drop the weakest.
- Thresholds must sit inside the range actually observed in the data. Do not
  extrapolate to values no trade has ever seen.
- Use hold_sell only when the data shows holding longer produced materially better
  PnL under that condition. It is not a default.
- Blocked entries have no outcome — you cannot know whether they would have won.
  Use them only to detect over-blocking: if a rule blocks most of the time, it is
  probably too tight and should be loosened or dropped.
- Every rationale must cite trade counts and results. "Seems risky" is not a rationale.
- Prefer few strong rules over many weak ones. If the data supports no change,
  return the current rules unchanged.
- Rule ids are stable identifiers: reuse the existing id when you keep or refine a
  rule, and use a new kebab-case id for a genuinely new one.`;

const LESSONS_SCHEMA = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'stable kebab-case identifier' },
          action: { type: 'string', enum: ['block_entry', 'hold_sell'] },
          when: {
            type: 'array',
            description: 'conditions, ANDed together; must not be empty',
            items: {
              type: 'object',
              properties: {
                indicator: { type: 'string', enum: [...INDICATORS] },
                op: { type: 'string', enum: ['>', '<', '>=', '<=', '=='] },
                value: { type: 'number' },
              },
              required: ['indicator', 'op', 'value'],
              additionalProperties: false,
            },
          },
          rationale: {
            type: 'string',
            description: 'must cite trade count and outcome',
          },
          evidence: {
            type: 'object',
            properties: {
              trades: { type: 'integer' },
              winRate: { type: 'number' },
              avgPnlPct: { type: 'number' },
            },
            required: ['trades', 'winRate', 'avgPnlPct'],
            additionalProperties: false,
          },
        },
        required: ['id', 'action', 'when', 'rationale', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['rules'],
  additionalProperties: false,
} as const;

// --- report building ----------------------------------------------------------

function n(v: number | undefined, digits = 2): string {
  return v === undefined ? '-' : v.toFixed(digits);
}

function bucketise(
  trades: Decision[],
  label: string,
  pick: (d: Decision) => number,
  edges: number[],
): string {
  const names = [
    `<${edges[0]}`,
    ...edges.slice(0, -1).map((e, i) => `${e}-${edges[i + 1]}`),
    `>${edges[edges.length - 1]}`,
  ];
  const buckets: Decision[][] = names.map(() => []);
  for (const t of trades) {
    const v = pick(t);
    let i = edges.findIndex((e) => v < e);
    if (i === -1) i = edges.length;
    buckets[i]!.push(t);
  }
  const parts = buckets
    .map((b, i) => {
      if (b.length === 0) return null;
      const wins = b.filter((t) => (t.pnlPct ?? 0) > 0).length;
      const avg = b.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / b.length;
      return `${names[i]}: ${b.length} trades, ${((wins / b.length) * 100).toFixed(0)}% win, avg ${avg.toFixed(2)}%`;
    })
    .filter(Boolean);
  return `${label} — ${parts.join(' | ')}`;
}

export function buildReport(lessons: LessonsFile, closed: Decision[], blocked: Decision[]): string {
  const lines: string[] = [];

  lines.push(`CURRENT RULES (version ${lessons.version}, updated ${lessons.updatedAt})`);
  if (lessons.rules.length === 0) lines.push('  (none)');
  for (const r of lessons.rules) {
    const when = r.when.map((c) => `${c.indicator}${c.op}${c.value}`).join(' AND ');
    lines.push(`  id=${r.id} action=${r.action} when=[${when}]`);
    lines.push(`    rationale: ${r.rationale}`);
  }

  lines.push('');
  lines.push(`CLOSED TRADES (n=${closed.length}) — indicators are from ENTRY time`);
  lines.push('  #  entry_lvl  entry_px  exit_px  pnl%   held_h  rsi14  atr%   emaSpread%  volRatio');
  closed.forEach((t, i) => {
    const ind = t.indicators;
    lines.push(
      `  ${String(i + 1).padStart(3)}  ${String(t.gridLevel).padStart(9)}  ` +
        `${n(t.entryPrice).padStart(8)}  ${n(t.price).padStart(7)}  ` +
        `${n(t.pnlPct).padStart(5)}  ${n(t.holdingHours, 1).padStart(6)}  ` +
        `${n(ind.rsi14, 1).padStart(5)}  ${n(ind.atrPct).padStart(5)}  ` +
        `${n(ind.emaSpreadPct).padStart(10)}  ${n(ind.volumeRatio).padStart(8)}`,
    );
  });

  const wins = closed.filter((t) => (t.pnlPct ?? 0) > 0).length;
  const totalUsdt = closed.reduce((s, t) => s + (t.pnlUsdt ?? 0), 0);
  const avgPct = closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length;
  const avgHold = closed.reduce((s, t) => s + (t.holdingHours ?? 0), 0) / closed.length;

  lines.push('');
  lines.push(
    `SUMMARY: ${closed.length} trades, ${wins} wins (${((wins / closed.length) * 100).toFixed(1)}%), ` +
      `avg ${avgPct.toFixed(2)}%, total ${totalUsdt.toFixed(2)} USDT, avg hold ${avgHold.toFixed(1)}h`,
  );
  lines.push(bucketise(closed, 'BY ENTRY ATR%', (d) => d.indicators.atrPct, [4, 8, 12]));
  lines.push(bucketise(closed, 'BY ENTRY RSI', (d) => d.indicators.rsi14, [35, 50, 65]));
  lines.push(
    bucketise(closed, 'BY ENTRY EMA SPREAD%', (d) => d.indicators.emaSpreadPct, [-2, 0, 2]),
  );

  lines.push('');
  lines.push(
    `BLOCKED ENTRIES (n=${blocked.length}) — prevented by current rules; outcome unknowable`,
  );
  const byRule = new Map<string, number>();
  for (const b of blocked) byRule.set(b.blockedBy ?? '?', (byRule.get(b.blockedBy ?? '?') ?? 0) + 1);
  for (const [rule, count] of byRule) lines.push(`  ${rule}: ${count} blocks`);
  blocked.slice(-10).forEach((b) => {
    lines.push(
      `  ${b.at} lvl ${b.gridLevel} px ${n(b.price)} by=${b.blockedBy} ` +
        `rsi ${n(b.indicators.rsi14, 1)} atr ${n(b.indicators.atrPct)}%`,
    );
  });

  return lines.join('\n');
}

// --- validation ---------------------------------------------------------------

/**
 * Structured outputs guarantee the shape; these are the semantic constraints the
 * schema cannot express. A bad rule set would silently mis-steer every future
 * trade, so a violation aborts rather than being repaired.
 */
export function validate(rules: Lesson[]): void {
  if (rules.length > MAX_RULES) {
    throw new Error(`Model returned ${rules.length} rules, limit is ${MAX_RULES}`);
  }
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) throw new Error(`Duplicate rule id: ${r.id}`);
    ids.add(r.id);
    if (r.when.length === 0) {
      throw new Error(`Rule ${r.id} has no conditions — it would fire unconditionally`);
    }
    for (const c of r.when) {
      if (!Number.isFinite(c.value)) throw new Error(`Rule ${r.id} has a non-finite threshold`);
    }
  }
}

export type SkipReason = 'not-enough-trades' | 'nothing-new';

/**
 * Decide whether this run is worth an API call. Re-analysing an unchanged log
 * every night costs tokens and produces churn in the rules for no new evidence.
 */
export function shouldRun(
  lessons: LessonsFile,
  closed: Decision[],
): { run: false; reason: SkipReason } | { run: true; fresh: number } {
  if (closed.length < MIN_CLOSED_TRADES) return { run: false, reason: 'not-enough-trades' };
  const since = Date.parse(lessons.updatedAt);
  const fresh = closed.filter((t) => Date.parse(t.at) > since).length;
  if (fresh === 0) return { run: false, reason: 'nothing-new' };
  return { run: true, fresh };
}

/** Stamp createdAt, preserving the birth date of any rule the model chose to keep. */
export function mergeRules(
  previous: LessonsFile,
  incoming: Omit<Lesson, 'createdAt'>[],
  now: string,
): Lesson[] {
  const existing = new Map(previous.rules.map((r) => [r.id, r]));
  return incoming.map((r) => ({ ...r, createdAt: existing.get(r.id)?.createdAt ?? now }));
}

// --- main ---------------------------------------------------------------------

export async function runEvaluator(): Promise<void> {
  const lessons = await loadLessons();
  const log = await loadDecisions();

  const closed = log.filter((d) => d.type === 'exit_filled').slice(-TRADE_WINDOW);
  const blocked = log.filter((d) => d.type === 'entry_blocked').slice(-BLOCK_WINDOW);

  const gate = shouldRun(lessons, closed);
  if (!gate.run) {
    console.log(
      gate.reason === 'not-enough-trades'
        ? `Only ${closed.length} closed trades (need ${MIN_CLOSED_TRADES}). Not enough signal — skipping.`
        : 'No trades closed since the last revision — nothing new to learn, skipping.',
    );
    return;
  }
  const fresh = gate.fresh;

  const report = buildReport(lessons, closed, blocked);
  const provider = selectProvider();
  console.log(
    `Analysing ${closed.length} closed trades (${fresh} new since last revision) via ${provider}...`,
  );

  const text = await complete(provider, SYSTEM_PROMPT, report, LESSONS_SCHEMA);

  let parsed: { rules: Omit<Lesson, 'createdAt'>[] };
  try {
    parsed = JSON.parse(text) as { rules: Omit<Lesson, 'createdAt'>[] };
  } catch {
    throw new Error(`Model output was not valid JSON: ${text.slice(0, 200)}`);
  }
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error('Model output has no "rules" array');
  }
  validate(parsed.rules as Lesson[]);

  const now = new Date().toISOString();
  const rules = mergeRules(lessons, parsed.rules, now);

  await writeJson(paths.lessonsBackup, lessons);
  await saveLessons({ version: lessons.version + 1, updatedAt: now, rules });

  const before = new Set(lessons.rules.map((r) => r.id));
  const after = new Set(rules.map((r) => r.id));
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));

  console.log(`\nlessons.json v${lessons.version} -> v${lessons.version + 1} (${rules.length} rules)`);
  if (added.length) console.log(`  added:   ${added.join(', ')}`);
  if (removed.length) console.log(`  removed: ${removed.join(', ')}`);
  for (const r of rules) {
    const when = r.when.map((c) => `${c.indicator}${c.op}${c.value}`).join(' AND ');
    console.log(`  [${r.action}] ${r.id}: ${when}`);
    console.log(`      ${r.rationale}`);
  }
  console.log(`\nPrevious version backed up to ${paths.lessonsBackup}`);
}

if (import.meta.main) {
  await runEvaluator();
}
