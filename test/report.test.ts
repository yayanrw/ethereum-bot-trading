import { describe, expect, test } from 'bun:test';
import { groupByDay, overallStats } from '../src/report.ts';
import type { Decision, IndicatorSnapshot } from '../src/types.ts';

const ind = (): IndicatorSnapshot => ({
  price: 1800,
  rsi14: 50,
  atrPct: 3,
  ema20: 1800,
  ema50: 1800,
  emaSpreadPct: 0,
  volumeRatio: 1,
  at: '2026-07-01T00:00:00.000Z',
});

function exit(at: string, pnlPct: number, pnlUsdt: number): Decision {
  return {
    id: `d-${at}-${pnlPct}`,
    type: 'exit_filled',
    at,
    symbol: 'ETH/USDT',
    gridLevel: 1800,
    price: 1900,
    qty: 0.05,
    entryPrice: 1800,
    pnlPct,
    pnlUsdt,
    holdingHours: 4,
    indicators: ind(),
  };
}

function blocked(at: string): Decision {
  return {
    id: `b-${at}`,
    type: 'entry_blocked',
    at,
    symbol: 'ETH/USDT',
    gridLevel: 1800,
    price: 1850,
    blockedBy: 'some-rule',
    indicators: ind(),
  };
}

describe('groupByDay', () => {
  test('empty log yields no days', () => {
    expect(groupByDay([])).toEqual([]);
  });

  test('ignores non-exit_filled decisions', () => {
    const days = groupByDay([blocked('2026-07-01T10:00:00.000Z')]);
    expect(days).toEqual([]);
  });

  test('groups by UTC calendar day and sorts ascending', () => {
    const days = groupByDay([
      exit('2026-07-02T01:00:00.000Z', 2, 2),
      exit('2026-07-01T23:00:00.000Z', 3, 3),
      exit('2026-07-01T01:00:00.000Z', -1, -1),
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-07-01', '2026-07-02']);
    expect(days[0]?.trades).toBe(2);
    expect(days[1]?.trades).toBe(1);
  });

  test('computes win rate, total pnl, and avg pnl% per day', () => {
    const days = groupByDay([
      exit('2026-07-01T01:00:00.000Z', 5, 10),
      exit('2026-07-01T02:00:00.000Z', -2, -4),
      exit('2026-07-01T03:00:00.000Z', 3, 6),
    ]);
    const d = days[0]!;
    expect(d.trades).toBe(3);
    expect(d.wins).toBe(2); // 5% and 3% win, -2% loses
    expect(d.winRatePct).toBeCloseTo((2 / 3) * 100, 6);
    expect(d.totalPnlUsdt).toBeCloseTo(12, 6);
    expect(d.avgPnlPct).toBeCloseTo(2, 6);
  });

  test('a breakeven trade (pnlPct 0) counts as a loss, not a win', () => {
    const days = groupByDay([exit('2026-07-01T01:00:00.000Z', 0, 0)]);
    expect(days[0]?.wins).toBe(0);
    expect(days[0]?.winRatePct).toBe(0);
  });
});

describe('overallStats', () => {
  test('undefined when there is nothing to summarise', () => {
    expect(overallStats([])).toBeUndefined();
  });

  test('rolls multiple days into one weighted total', () => {
    const days = groupByDay([
      exit('2026-07-01T01:00:00.000Z', 10, 10),
      exit('2026-07-01T02:00:00.000Z', 10, 10),
      exit('2026-07-02T01:00:00.000Z', -50, -25),
    ]);
    const total = overallStats(days)!;
    expect(total.trades).toBe(3);
    expect(total.wins).toBe(2);
    expect(total.winRatePct).toBeCloseTo((2 / 3) * 100, 6);
    expect(total.totalPnlUsdt).toBeCloseTo(-5, 6);
    // Weighted by trade count: (10+10-50)/3, not a plain mean of the two daily averages.
    expect(total.avgPnlPct).toBeCloseTo(-10, 6);
  });
});
