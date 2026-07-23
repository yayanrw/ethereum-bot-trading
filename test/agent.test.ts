import { describe, expect, test } from 'bun:test';
import { atr, ema, rsi, snapshot, volumeRatio, type Candle } from '../src/core/indicators.ts';
import {
  decideTick,
  evaluateRules,
  gridLevels,
  ruleMatches,
  sellTargetFor,
  targetBidLevels,
} from '../src/strategies/grid.ts';
import type { GridConfig, IndicatorSnapshot, LessonsFile, Lot, PositionsFile } from '../src/types.ts';

const config: GridConfig = {
  symbol: 'ETH/USDT',
  upper: 3200,
  lower: 2800,
  step: 100,
  usdtPerLevel: 100,
  maxOpenBids: 3,
};

function snap(over: Partial<IndicatorSnapshot> = {}): IndicatorSnapshot {
  return {
    price: 3050,
    rsi14: 50,
    atrPct: 3,
    ema20: 3000,
    ema50: 3000,
    emaSpreadPct: 0,
    volumeRatio: 1,
    at: '2026-07-23T00:00:00.000Z',
    ...over,
  };
}

function lot(over: Partial<Lot> = {}): Lot {
  return {
    id: 'lot-1',
    gridLevel: 2900,
    entryPrice: 2900,
    qty: 0.0345,
    costUsdt: 100,
    openedAt: '2026-07-22T00:00:00.000Z',
    entryIndicators: snap(),
    ...over,
  };
}

function lessons(rules: LessonsFile['rules']): LessonsFile {
  return { version: 1, updatedAt: '1970-01-01T00:00:00.000Z', rules };
}

const positions = (over: Partial<PositionsFile> = {}): PositionsFile => ({
  lots: [],
  bids: [],
  ...over,
});

describe('grid maths', () => {
  test('levels span the configured range on the step, ascending', () => {
    expect(gridLevels(config)).toEqual([2800, 2900, 3000, 3100, 3200]);
  });

  test('levels avoid float drift on fractional steps', () => {
    const levels = gridLevels({ ...config, lower: 0.1, upper: 0.5, step: 0.1 });
    expect(levels).toEqual([0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  test('bids target the N nearest empty levels at or below price', () => {
    const levels = gridLevels(config);
    expect(targetBidLevels(3050, levels, [], 3)).toEqual([3000, 2900, 2800]);
  });

  test('a level that already holds a lot is skipped, not re-bid', () => {
    const levels = gridLevels(config);
    const target = targetBidLevels(3050, levels, [lot({ gridLevel: 2900 })], 3);
    expect(target).toEqual([3000, 2800]);
  });

  test('sell target is the first level above the entry', () => {
    expect(sellTargetFor(lot({ gridLevel: 2900, entryPrice: 2900 }), gridLevels(config))).toBe(3000);
  });

  test('sell target clears an entry that slipped above its level', () => {
    // Filled at 2950 on the 2900 level: selling at 2900 would realise a loss.
    expect(sellTargetFor(lot({ gridLevel: 2900, entryPrice: 2950 }), gridLevels(config))).toBe(3000);
  });

  test('a lot above the top of the grid has no target', () => {
    expect(sellTargetFor(lot({ gridLevel: 3200, entryPrice: 3200 }), gridLevels(config))).toBeUndefined();
  });
});

describe('lessons rule engine', () => {
  const atrGuard = {
    id: 'seed-atr-guard',
    action: 'block_entry' as const,
    when: [{ indicator: 'atrPct' as const, op: '>' as const, value: 12 }],
    rationale: 'seed',
    createdAt: '1970-01-01T00:00:00.000Z',
  };

  test('fires above the threshold', () => {
    const v = evaluateRules(snap({ atrPct: 15 }), lessons([atrGuard]), 'block_entry');
    expect(v.allowed).toBe(false);
    expect(v.blockedBy).toBe('seed-atr-guard');
  });

  test('stays quiet below the threshold', () => {
    expect(evaluateRules(snap({ atrPct: 8 }), lessons([atrGuard]), 'block_entry').allowed).toBe(true);
  });

  test('does not apply a block_entry rule to the sell side', () => {
    expect(evaluateRules(snap({ atrPct: 15 }), lessons([atrGuard]), 'hold_sell').allowed).toBe(true);
  });

  test('multi-condition rules require every condition', () => {
    const rule = {
      ...atrGuard,
      id: 'multi',
      when: [
        { indicator: 'atrPct' as const, op: '>' as const, value: 10 },
        { indicator: 'rsi14' as const, op: '>' as const, value: 70 },
      ],
    };
    expect(ruleMatches(snap({ atrPct: 15, rsi14: 75 }), rule)).toBe(true);
    expect(ruleMatches(snap({ atrPct: 15, rsi14: 50 }), rule)).toBe(false);
    expect(ruleMatches(snap({ atrPct: 5, rsi14: 75 }), rule)).toBe(false);
  });

  test('a rule with no conditions never fires', () => {
    // Otherwise a malformed rule would silently halt all trading.
    expect(ruleMatches(snap(), { ...atrGuard, when: [] })).toBe(false);
  });
});

describe('decideTick', () => {
  const quiet = lessons([]);

  test('places bids on the nearest empty levels', () => {
    const plan = decideTick({ snapshot: snap({ price: 3050 }), positions: positions(), lessons: quiet, config });
    expect(plan.placeBids.map((b) => b.gridLevel)).toEqual([3000, 2900, 2800]);
    expect(plan.cancelBids).toHaveLength(0);
  });

  test('sizes each bid at USDT_PER_LEVEL', () => {
    const plan = decideTick({ snapshot: snap({ price: 3050 }), positions: positions(), lessons: quiet, config });
    const bid = plan.placeBids.find((b) => b.gridLevel === 3000)!;
    expect(bid.qty).toBeCloseTo(100 / 3000, 8);
  });

  test('a blocked entry cancels resting bids instead of leaving them on the book', () => {
    const resting = {
      orderId: 'o1',
      gridLevel: 3000,
      price: 3000,
      qty: 0.03,
      placedAt: '2026-07-22T00:00:00.000Z',
      placedIndicators: snap(),
    };
    const rules = lessons([
      {
        id: 'atr',
        action: 'block_entry',
        when: [{ indicator: 'atrPct', op: '>', value: 12 }],
        rationale: 'x',
        createdAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
    const plan = decideTick({
      snapshot: snap({ atrPct: 20 }),
      positions: positions({ bids: [resting] }),
      lessons: rules,
      config,
    });
    expect(plan.placeBids).toHaveLength(0);
    expect(plan.cancelBids).toEqual([resting]);
    expect(plan.entryBlockedBy).toBe('atr');
    expect(plan.skipped[0]?.type).toBe('entry_blocked');
  });

  test('a repeated block is not re-logged every tick', () => {
    const rules = lessons([
      {
        id: 'atr',
        action: 'block_entry',
        when: [{ indicator: 'atrPct', op: '>', value: 12 }],
        rationale: 'x',
        createdAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
    const plan = decideTick({
      snapshot: snap({ atrPct: 20 }),
      positions: positions({ entryBlockedBy: 'atr' }),
      lessons: rules,
      config,
    });
    expect(plan.skipped).toHaveLength(0);
    expect(plan.entryBlockedBy).toBe('atr');
  });

  test('sells a lot once price reaches its +1 grid target', () => {
    const plan = decideTick({
      snapshot: snap({ price: 3010 }),
      positions: positions({ lots: [lot()] }),
      lessons: quiet,
      config,
    });
    expect(plan.placeSells).toHaveLength(1);
    expect(plan.placeSells[0]?.targetLevel).toBe(3000);
    expect(plan.placeSells[0]?.price).toBe(3000);
  });

  test('does not sell before price reaches the target', () => {
    // A resting sell at the target would be filled by the exchange before the
    // bot could apply a hold_sell rule, so no order goes out until price is there.
    const plan = decideTick({
      snapshot: snap({ price: 2950 }),
      positions: positions({ lots: [lot()] }),
      lessons: quiet,
      config,
    });
    expect(plan.placeSells).toHaveLength(0);
  });

  test('a lot below target is not logged as held', () => {
    const rules = lessons([
      {
        id: 'ride-momentum',
        action: 'hold_sell',
        when: [{ indicator: 'emaSpreadPct', op: '>', value: 2 }],
        rationale: 'x',
        createdAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
    const plan = decideTick({
      snapshot: snap({ price: 2950, emaSpreadPct: 4 }),
      positions: positions({ lots: [lot()] }),
      lessons: rules,
      config,
    });
    expect(plan.skipped).toHaveLength(0);
    expect(plan.holdState[0]?.blockedBy).toBeUndefined();
  });

  test('a hold_sell rule pulls an in-flight sell and records exit_held', () => {
    const rules = lessons([
      {
        id: 'ride-momentum',
        action: 'hold_sell',
        when: [{ indicator: 'emaSpreadPct', op: '>', value: 2 }],
        rationale: 'x',
        createdAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
    const held = lot({ sellOrderId: 'sell-1' });
    const plan = decideTick({
      snapshot: snap({ price: 3010, emaSpreadPct: 4 }),
      positions: positions({ lots: [held] }),
      lessons: rules,
      config,
    });
    expect(plan.placeSells).toHaveLength(0);
    expect(plan.cancelSells).toEqual([held]);
    expect(plan.skipped[0]?.type).toBe('exit_held');
    expect(plan.skipped[0]?.blockedBy).toBe('ride-momentum');
    expect(plan.holdState[0]?.blockedBy).toBe('ride-momentum');
  });

  test('an already-held lot is not re-logged every tick', () => {
    const rules = lessons([
      {
        id: 'ride-momentum',
        action: 'hold_sell',
        when: [{ indicator: 'emaSpreadPct', op: '>', value: 2 }],
        rationale: 'x',
        createdAt: '1970-01-01T00:00:00.000Z',
      },
    ]);
    const plan = decideTick({
      snapshot: snap({ price: 3010, emaSpreadPct: 4 }),
      positions: positions({ lots: [lot({ heldBy: 'ride-momentum' })] }),
      lessons: rules,
      config,
    });
    expect(plan.skipped).toHaveLength(0);
    expect(plan.holdState[0]?.blockedBy).toBe('ride-momentum');
  });

  test('lifting a hold clears the marker so the next hold logs again', () => {
    const plan = decideTick({
      snapshot: snap({ price: 3010 }),
      positions: positions({ lots: [lot({ heldBy: 'ride-momentum' })] }),
      lessons: quiet,
      config,
    });
    expect(plan.holdState[0]?.blockedBy).toBeUndefined();
  });

  test('does not double-submit a sell that is already in flight', () => {
    const plan = decideTick({
      snapshot: snap({ price: 3010 }),
      positions: positions({ lots: [lot({ sellOrderId: 'sell-1' })] }),
      lessons: quiet,
      config,
    });
    expect(plan.placeSells).toHaveLength(0);
  });
});

describe('indicators', () => {
  const flat = (n: number, price: number, vol = 10): Candle[] =>
    Array.from({ length: n }, (_, i) => [i, price, price, price, price, vol] as Candle);

  const rising = (n: number): Candle[] =>
    Array.from({ length: n }, (_, i) => {
      const p = 100 + i;
      return [i, p, p + 0.5, p - 0.5, p, 10] as Candle;
    });

  test('ema of a constant series is that constant', () => {
    expect(ema(Array(60).fill(100), 20)).toBeCloseTo(100, 6);
  });

  test('rsi of a monotonically rising series is 100', () => {
    expect(rsi(rising(60).map((c) => c[4]), 14)).toBeCloseTo(100, 6);
  });

  test('rsi of a monotonically falling series is 0', () => {
    const falling = rising(60).map((c) => c[4]).reverse();
    expect(rsi(falling, 14)).toBeCloseTo(0, 6);
  });

  test('atr of flat candles is 0', () => {
    expect(atr(flat(60, 3000), 14)).toBeCloseTo(0, 6);
  });

  test('volumeRatio compares the last candle to the previous 20', () => {
    const candles = flat(30, 3000, 10);
    candles[candles.length - 1]![5] = 30;
    expect(volumeRatio(candles, 20)).toBeCloseTo(3, 6);
  });

  test('snapshot normalises atr against the live price, not the candle close', () => {
    const candles = rising(60);
    const s = snapshot(candles, 200);
    expect(s.price).toBe(200);
    expect(s.atrPct).toBeCloseTo((atr(candles, 14) / 200) * 100, 8);
  });

  test('snapshot refuses to run on too little history', () => {
    expect(() => snapshot(rising(10), 3000)).toThrow(/at least 51/);
  });
});
