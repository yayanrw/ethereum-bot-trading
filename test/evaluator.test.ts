import { describe, expect, test } from 'bun:test';
import {
  buildReport,
  mergeRules,
  shouldRun,
  validate,
} from '../src/strategies/evaluator.ts';
import type { Decision, IndicatorSnapshot, Lesson, LessonsFile } from '../src/types.ts';

function ind(over: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: 3000,
    rsi14: 50,
    atrPct: 3,
    ema20: 3000,
    ema50: 3000,
    emaSpreadPct: 0,
    volumeRatio: 1,
    at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

/** Synthetic history: calm-market entries win, high-volatility entries lose. */
function syntheticTrades(): Decision[] {
  const mk = (i: number, atrPct: number, pnlPct: number): Decision => ({
    id: `t${i}`,
    type: 'exit_filled',
    at: `2026-07-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
    symbol: 'ETH/USDT',
    gridLevel: 2900,
    price: 3000,
    qty: 0.034,
    entryPrice: 2900,
    pnlPct,
    pnlUsdt: pnlPct,
    holdingHours: 20,
    indicators: ind({ atrPct }),
  });
  return [
    ...Array.from({ length: 8 }, (_, i) => mk(i, 3, 3.4)),
    ...Array.from({ length: 6 }, (_, i) => mk(i + 8, 14, -2.1)),
  ];
}

const lessons = (rules: Lesson[], updatedAt = '1970-01-01T00:00:00.000Z'): LessonsFile => ({
  version: 1,
  updatedAt,
  rules,
});

const atrRule: Lesson = {
  id: 'seed-atr-guard',
  action: 'block_entry',
  when: [{ indicator: 'atrPct', op: '>', value: 12 }],
  rationale: 'seed',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('run gate', () => {
  test('skips below the minimum trade count rather than burning tokens', () => {
    const few = syntheticTrades().slice(0, 3);
    expect(shouldRun(lessons([]), few)).toEqual({ run: false, reason: 'not-enough-trades' });
  });

  test('skips when nothing has closed since the last revision', () => {
    const trades = syntheticTrades();
    const result = shouldRun(lessons([], '2027-01-01T00:00:00.000Z'), trades);
    expect(result).toEqual({ run: false, reason: 'nothing-new' });
  });

  test('runs, and counts only trades newer than the last revision as fresh', () => {
    const trades = syntheticTrades();
    // Revision at Jul 10 leaves the Jul 11..14 trades fresh.
    const result = shouldRun(lessons([], '2026-07-10T00:00:00.000Z'), trades);
    expect(result).toEqual({ run: true, fresh: 4 });
  });
});

describe('report', () => {
  const report = buildReport(lessons([atrRule]), syntheticTrades(), [
    {
      id: 'b1',
      type: 'entry_blocked',
      at: '2026-07-15T00:00:00.000Z',
      symbol: 'ETH/USDT',
      gridLevel: 2800,
      price: 2850,
      blockedBy: 'seed-atr-guard',
      indicators: ind({ atrPct: 18 }),
    },
  ]);

  test('states the current rules the model must revise', () => {
    expect(report).toContain('id=seed-atr-guard action=block_entry when=[atrPct>12]');
  });

  test('reports the aggregate the model needs to spot the pattern', () => {
    expect(report).toContain('14 trades, 8 wins (57.1%)');
  });

  test('buckets by entry ATR so the volatility split is visible without arithmetic', () => {
    // Winners all sat under 4%, losers all above 12%.
    expect(report).toMatch(/BY ENTRY ATR% — <4: 8 trades, 100% win, avg 3\.40%/);
    expect(report).toMatch(/>12: 6 trades, 0% win, avg -2\.10%/);
  });

  test('surfaces block counts per rule so an over-tight rule is detectable', () => {
    expect(report).toContain('seed-atr-guard: 1 blocks');
  });
});

describe('validation of model output', () => {
  const ok = { ...atrRule } as Lesson;

  test('accepts a sane rule set', () => {
    expect(() => validate([ok])).not.toThrow();
  });

  test('rejects a rule with no conditions', () => {
    expect(() => validate([{ ...ok, when: [] }])).toThrow(/no conditions/);
  });

  test('rejects duplicate ids', () => {
    expect(() => validate([ok, { ...ok }])).toThrow(/Duplicate rule id/);
  });

  test('rejects more rules than the cap', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...ok, id: `r${i}` }));
    expect(() => validate(many)).toThrow(/limit is 8/);
  });

  test('rejects a non-finite threshold', () => {
    expect(() =>
      validate([{ ...ok, when: [{ indicator: 'atrPct', op: '>', value: Number.NaN }] }]),
    ).toThrow(/non-finite/);
  });
});

describe('rule merge', () => {
  const now = '2026-07-23T02:00:00.000Z';

  test('a kept rule retains its original creation date', () => {
    const merged = mergeRules(lessons([atrRule]), [{ ...atrRule, when: [{ indicator: 'atrPct', op: '>', value: 10 }] } as Lesson], now);
    expect(merged[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged[0]?.when[0]?.value).toBe(10);
  });

  test('a new rule is stamped with the current time', () => {
    const merged = mergeRules(lessons([atrRule]), [{ ...atrRule, id: 'brand-new' } as Lesson], now);
    expect(merged[0]?.createdAt).toBe(now);
  });

  test('a rule the model omitted is dropped', () => {
    const merged = mergeRules(lessons([atrRule]), [], now);
    expect(merged).toHaveLength(0);
  });
});
