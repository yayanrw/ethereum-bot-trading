import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import type { Exchange, OrderStatus } from '../src/core/exchange.ts';
import type { Candle } from '../src/core/indicators.ts';
import { freshBreakerState, trip } from '../src/core/breaker.ts';
import { loadDecisions, loadPositions, saveLessons, savePositions } from '../src/core/memory.ts';
import { tick } from '../src/index.ts';
import type { Decision, Lesson } from '../src/types.ts';

/**
 * A scripted exchange. Price is driven by the test; resting orders fill when the
 * price crosses them, exactly as they would on a real book.
 */
class FakeExchange implements Exchange {
  price = 3050;
  readonly orders = new Map<
    string,
    { side: 'buy' | 'sell'; qty: number; price: number; state: OrderStatus['state']; filled: number }
  >();
  readonly cancelled: string[] = [];
  private seq = 0;

  async init(): Promise<void> {}

  async fetchClosedCandles(): Promise<Candle[]> {
    // 60 flat candles: RSI 50, ATR 0 — a calm market, so no seed rule fires and
    // the test is exercising the loop rather than the rule engine.
    return Array.from(
      { length: 60 },
      (_, i) => [i * 3_600_000, 3000, 3000, 3000, 3000, 10] as Candle,
    );
  }

  async fetchPrice(): Promise<number> {
    return this.price;
  }

  async createLimitBuy(qty: number, price: number): Promise<string> {
    const id = `b${++this.seq}`;
    this.orders.set(id, { side: 'buy', qty, price, state: 'open', filled: 0 });
    return id;
  }

  async createLimitSell(qty: number, price: number): Promise<string> {
    const id = `s${++this.seq}`;
    this.orders.set(id, { side: 'sell', qty, price, state: 'open', filled: 0 });
    return id;
  }

  async fetchOrderStatus(id: string): Promise<OrderStatus> {
    const o = this.orders.get(id);
    if (!o) return { id, state: 'canceled', filled: 0, average: 0 };
    return { id, state: o.state, filled: o.filled, average: o.price };
  }

  async cancelOrder(id: string): Promise<void> {
    this.cancelled.push(id);
    const o = this.orders.get(id);
    if (o && o.state === 'open') o.state = 'canceled';
  }

  amountFor(usdt: number, price: number): number {
    return Math.round((usdt / price) * 1e5) / 1e5;
  }
  priceFor(price: number): number {
    return price;
  }
  minCostUsdt(): number {
    return 0;
  }

  markPrice(price: number): void {
    for (const o of this.orders.values()) {
      if (o.state !== 'open') continue;
      if (o.side === 'buy' ? price <= o.price : price >= o.price) {
        o.state = 'closed';
        o.filled = o.qty;
      }
    }
  }

  /** Move the market and let resting orders fill, as a tick would. */
  moveTo(price: number): void {
    this.price = price;
  }
}

const config: Config = {
  grid: {
    symbol: 'ETH/USDT',
    upper: 3200,
    lower: 2800,
    step: 100,
    usdtPerLevel: 100,
    maxOpenBids: 2,
  },
  breaker: { maxDrawdownUsdt: 0, maxConsecutiveErrors: 0, maxPriceJumpPct: 0 },
  timeframe: '1h',
  pollIntervalMs: 1000,
  dryRun: true,
  testnet: false,
  exchange: { apiKey: '', secret: '' },
  dataDir: 'data',
};

const quietLessons = { version: 1, updatedAt: '1970-01-01T00:00:00.000Z', rules: [] as Lesson[] };

let dir: string;
const prevDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grid-test-'));
  process.env.DATA_DIR = dir;
  await savePositions({ lots: [], bids: [] });
  await saveLessons(quietLessons);
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  await rm(dir, { recursive: true, force: true });
});

const byType = (log: Decision[], t: Decision['type']) => log.filter((d) => d.type === t);

describe('full round trip', () => {
  test('bid rests, fills into a lot, sells at +1 grid with correct PnL', async () => {
    const ex = new FakeExchange();

    // Tick 1 — price 3050: bids go out at 3000 and 2900, nothing fills.
    await tick(ex, config);
    let pos = await loadPositions();
    expect(pos.bids.map((b) => b.gridLevel).sort()).toEqual([2900, 3000]);
    expect(pos.lots).toHaveLength(0);

    // Tick 2 — price drops to 2980: the 3000 bid fills, becoming a lot.
    ex.moveTo(2980);
    await tick(ex, config);
    pos = await loadPositions();
    expect(pos.lots).toHaveLength(1);
    expect(pos.lots[0]?.gridLevel).toBe(3000);
    expect(pos.lots[0]?.entryPrice).toBe(3000);
    // No sell yet — price is nowhere near the 3100 target.
    expect(pos.lots[0]?.sellOrderId).toBeUndefined();

    // Tick 3 — price rallies past the target: the sell is submitted at 3100.
    ex.moveTo(3120);
    await tick(ex, config);
    pos = await loadPositions();
    expect(pos.lots).toHaveLength(1);
    expect(ex.orders.get(pos.lots[0]!.sellOrderId!)?.price).toBe(3100);

    // Tick 4 — the sell is confirmed filled and the lot closes.
    await tick(ex, config);
    pos = await loadPositions();
    expect(pos.lots).toHaveLength(0);

    const log = await loadDecisions();
    const entries = byType(log, 'entry_filled');
    const exits = byType(log, 'exit_filled');
    expect(entries).toHaveLength(1);
    expect(exits).toHaveLength(1);

    const exit = exits[0]!;
    const qty = entries[0]!.qty!;
    expect(exit.entryPrice).toBe(3000);
    expect(exit.price).toBe(3100);
    expect(exit.pnlPct).toBeCloseTo((3100 / 3000 - 1) * 100, 6);
    expect(exit.pnlUsdt).toBeCloseTo((3100 - 3000) * qty, 6);
    // The evaluator correlates outcomes against entry-time conditions.
    expect(exit.indicators).toBeDefined();
  });

  test('a level that just sold is bid again, honouring the ladder', async () => {
    const ex = new FakeExchange();
    await tick(ex, config); // bids at 3000, 2900
    ex.moveTo(2980);
    await tick(ex, config); // 3000 fills -> lot
    ex.moveTo(3120);
    await tick(ex, config); // target reached -> sell submitted
    await tick(ex, config); // sell confirmed filled -> lot closed

    // Price is back above 3000 and the level is empty again, so it gets re-bid.
    const pos = await loadPositions();
    expect(pos.bids.map((b) => b.gridLevel)).toContain(3000);
  });

  test('an occupied level is not re-bid while its lot is open', async () => {
    const ex = new FakeExchange();
    await tick(ex, config);
    ex.moveTo(2980);
    await tick(ex, config);

    const pos = await loadPositions();
    expect(pos.lots.map((l) => l.gridLevel)).toEqual([3000]);
    expect(pos.bids.map((b) => b.gridLevel)).not.toContain(3000);
  });
});

describe('lessons middleware, end to end', () => {
  test('a block_entry rule cancels resting bids and places none', async () => {
    const ex = new FakeExchange();
    await tick(ex, config);
    const restingIds = (await loadPositions()).bids.map((b) => b.orderId);
    expect(restingIds.length).toBeGreaterThan(0);

    // Flat candles give atrPct 0, so a rule of "atrPct >= 0" blocks unconditionally.
    await saveLessons({
      version: 2,
      updatedAt: new Date().toISOString(),
      rules: [
        {
          id: 'test-block',
          action: 'block_entry',
          when: [{ indicator: 'atrPct', op: '>=', value: 0 }],
          rationale: 'test',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await tick(ex, config);
    const pos = await loadPositions();
    expect(pos.bids).toHaveLength(0);
    for (const id of restingIds) expect(ex.cancelled).toContain(id);

    const blocked = byType(await loadDecisions(), 'entry_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.blockedBy).toBe('test-block');

    // A second tick under the same rule must not re-log the same block.
    await tick(ex, config);
    expect(byType(await loadDecisions(), 'entry_blocked')).toHaveLength(1);
  });

  test('a hold_sell rule keeps a profitable lot instead of selling it', async () => {
    const ex = new FakeExchange();
    await tick(ex, config);
    ex.moveTo(2980);
    await tick(ex, config); // lot opened at 3000, target 3100 not yet reached

    await saveLessons({
      version: 2,
      updatedAt: new Date().toISOString(),
      rules: [
        {
          id: 'test-hold',
          action: 'hold_sell',
          when: [{ indicator: 'atrPct', op: '>=', value: 0 }],
          rationale: 'test',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    // Price reaches the target, but the rule stops the sell from being submitted.
    ex.moveTo(3120);
    await tick(ex, config);

    const pos = await loadPositions();
    expect(pos.lots).toHaveLength(1);
    expect(pos.lots[0]?.sellOrderId).toBeUndefined();
    expect(pos.lots[0]?.heldBy).toBe('test-hold');

    const log = await loadDecisions();
    expect(byType(log, 'exit_filled')).toHaveLength(0);
    expect(byType(log, 'exit_held')).toHaveLength(1);
  });

  test('lifting the hold puts the sell back on the book', async () => {
    const ex = new FakeExchange();
    await tick(ex, config);
    ex.moveTo(2980);
    await tick(ex, config);

    const holdRule = {
      version: 2,
      updatedAt: new Date().toISOString(),
      rules: [
        {
          id: 'test-hold',
          action: 'hold_sell' as const,
          when: [{ indicator: 'atrPct' as const, op: '>=' as const, value: 0 }],
          rationale: 'test',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await saveLessons(holdRule);
    ex.moveTo(3120); // at target, but held
    await tick(ex, config);
    expect((await loadPositions()).lots[0]?.sellOrderId).toBeUndefined();
    expect((await loadPositions()).lots[0]?.heldBy).toBe('test-hold');

    await saveLessons({ ...holdRule, version: 3, rules: [] });
    await tick(ex, config);
    const lot = (await loadPositions()).lots[0]!;
    expect(lot.sellOrderId).toBeDefined();
    expect(lot.heldBy).toBeUndefined();
  });
});

describe('circuit breaker, end to end', () => {
  test('drawdown trips within a tick and halts new entries', async () => {
    // Tight limit so a single underwater lot trips it.
    const cfg = { ...config, breaker: { ...config.breaker, maxDrawdownUsdt: 5 } };
    const ex = new FakeExchange();

    // Open a lot at 3000, then let price fall so it's deep underwater.
    let breaker = await tick(ex, cfg, freshBreakerState); // bids at 3000, 2900
    ex.moveTo(2980);
    breaker = await tick(ex, cfg, breaker); // 3000 bid fills -> lot
    expect((await loadPositions()).lots).toHaveLength(1);
    expect(breaker.tripped).toBe(false);

    // Price crashes to 2500: the resting bids at 2900/2800 also fill on the way
    // down (that IS the strategy), so now three lots are underwater and the
    // aggregate loss trips the breaker.
    ex.moveTo(2500);
    breaker = await tick(ex, cfg, breaker);

    expect(breaker.tripped).toBe(true);
    expect(breaker.reason).toMatch(/drawdown/);
    const pos = await loadPositions();
    // Entries halted: no resting bids remain and none are re-placed.
    expect(pos.bids).toHaveLength(0);
    // Every lot is kept — no cutloss, that is the whole point.
    expect(pos.lots).toHaveLength(3);
    expect(pos.entryBlockedBy).toBe('circuit-breaker');
  });

  test('a tripped breaker still lets a profitable lot sell', async () => {
    const ex = new FakeExchange();
    let breaker = await tick(ex, config, freshBreakerState);
    ex.moveTo(2980);
    breaker = await tick(ex, config, breaker); // lot opened at 3000

    // Force-trip the breaker, then push price to the lot's target.
    breaker = trip(breaker, 'manual test trip');
    ex.moveTo(3120);
    breaker = await tick(ex, config, breaker); // sell submitted despite halt
    breaker = await tick(ex, config, breaker); // sell confirmed filled

    const pos = await loadPositions();
    expect(pos.lots).toHaveLength(0); // exit went through
    expect(pos.bids).toHaveLength(0); // but no new entries
    expect(byType(await loadDecisions(), 'exit_filled')).toHaveLength(1);
  });

  test('a price jump larger than the threshold skips the tick', async () => {
    const cfg = { ...config, breaker: { ...config.breaker, maxPriceJumpPct: 15 } };
    const ex = new FakeExchange();

    // First tick establishes lastPrice at 3050 and places bids.
    let breaker = await tick(ex, cfg, freshBreakerState);
    expect((await loadPositions()).bids.length).toBeGreaterThan(0);
    const bidsBefore = (await loadPositions()).bids.length;

    // A 20% single-tick spike: skipped, no orders touched, lastPrice updated.
    ex.moveTo(3660);
    breaker = await tick(ex, cfg, breaker);
    expect(breaker.lastPrice).toBe(3660);
    expect((await loadPositions()).bids).toHaveLength(bidsBefore); // untouched
  });
});
