import { describe, expect, test } from 'bun:test';
import {
  checkDrawdown,
  checkPriceJump,
  freshBreakerState,
  shouldTripErrors,
  trip,
  unrealizedLossUsdt,
} from '../src/core/breaker.ts';
import type { IndicatorSnapshot, Lot } from '../src/types.ts';

const ind = (): IndicatorSnapshot => ({
  price: 2000,
  rsi14: 50,
  atrPct: 3,
  ema20: 2000,
  ema50: 2000,
  emaSpreadPct: 0,
  volumeRatio: 1,
  at: '2026-07-24T00:00:00.000Z',
});

function lot(entryPrice: number, qty: number): Lot {
  return {
    id: `lot-${entryPrice}`,
    gridLevel: entryPrice,
    entryPrice,
    qty,
    costUsdt: entryPrice * qty,
    openedAt: '2026-07-24T00:00:00.000Z',
    entryIndicators: ind(),
  };
}

describe('unrealizedLossUsdt', () => {
  test('sums only underwater lots', () => {
    // Bought at 2000 (0.5) and 1800 (0.5); price now 1700.
    // Lot A: (1700-2000)*0.5 = -150 loss. Lot B: (1700-1800)*0.5 = -50 loss.
    const loss = unrealizedLossUsdt([lot(2000, 0.5), lot(1800, 0.5)], 1700);
    expect(loss).toBeCloseTo(200, 6);
  });

  test('a lot in profit contributes zero loss', () => {
    const loss = unrealizedLossUsdt([lot(1500, 1)], 1700);
    expect(loss).toBe(0);
  });

  test('no lots means no loss', () => {
    expect(unrealizedLossUsdt([], 1700)).toBe(0);
  });
});

describe('checkDrawdown', () => {
  const lots = [lot(2000, 0.5), lot(1800, 0.5)]; // 200 USDT loss at price 1700

  test('trips when loss exceeds the limit', () => {
    expect(checkDrawdown(lots, 1700, 150)).toMatch(/drawdown 200.00 USDT exceeds limit 150/);
  });

  test('does not trip at or below the limit', () => {
    expect(checkDrawdown(lots, 1700, 200)).toBeUndefined();
    expect(checkDrawdown(lots, 1700, 300)).toBeUndefined();
  });

  test('disabled when the limit is 0', () => {
    expect(checkDrawdown(lots, 1000, 0)).toBeUndefined();
  });
});

describe('checkPriceJump', () => {
  test('trips a jump larger than the threshold', () => {
    // 2000 -> 1600 is a 20% drop.
    expect(checkPriceJump(1600, 2000, 15)).toMatch(/moved 20.0%/);
  });

  test('passes a move within the threshold', () => {
    expect(checkPriceJump(1900, 2000, 15)).toBeUndefined();
  });

  test('always passes the first tick, when there is no prior price', () => {
    expect(checkPriceJump(2000, undefined, 15)).toBeUndefined();
  });

  test('disabled when the threshold is 0', () => {
    expect(checkPriceJump(1000, 2000, 0)).toBeUndefined();
  });
});

describe('shouldTripErrors', () => {
  test('trips at or above the max', () => {
    expect(shouldTripErrors(5, 5)).toBe(true);
    expect(shouldTripErrors(6, 5)).toBe(true);
  });

  test('does not trip below the max', () => {
    expect(shouldTripErrors(4, 5)).toBe(false);
  });

  test('disabled when the max is 0', () => {
    expect(shouldTripErrors(100, 0)).toBe(false);
  });
});

describe('trip', () => {
  const now = () => '2026-07-24T12:00:00.000Z';

  test('latches with reason and timestamp', () => {
    const s = trip(freshBreakerState, 'drawdown', now);
    expect(s.tripped).toBe(true);
    expect(s.reason).toBe('drawdown');
    expect(s.trippedAt).toBe('2026-07-24T12:00:00.000Z');
  });

  test('is idempotent — keeps the first reason', () => {
    const first = trip(freshBreakerState, 'first reason', () => '2026-07-24T12:00:00.000Z');
    const second = trip(first, 'second reason', () => '2026-07-24T13:00:00.000Z');
    expect(second.reason).toBe('first reason');
    expect(second.trippedAt).toBe('2026-07-24T12:00:00.000Z');
  });

  test('does not mutate the input', () => {
    const input = { ...freshBreakerState };
    trip(input, 'x', now);
    expect(input.tripped).toBe(false);
  });
});
