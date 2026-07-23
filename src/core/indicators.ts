import type { IndicatorSnapshot } from '../types.ts';

/** ccxt OHLCV row: [timestamp, open, high, low, close, volume] */
export type Candle = [number, number, number, number, number, number];

/** Longest lookback we need (ema50 seeds on 50 closes, +1 for a prior value). */
export const MIN_CANDLES = 51;

/** Exponential moving average, seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): number {
  if (values.length < period) throw new Error(`ema(${period}) needs ${period} values, got ${values.length}`);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let out = sum / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out = values[i]! * k + out * (1 - k);
  return out;
}

/** Wilder's RSI. Returns 0-100; 100 when there are no losses in the window. */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) {
    throw new Error(`rsi(${period}) needs ${period + 1} closes, got ${closes.length}`);
  }
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder's ATR in quote currency. */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) {
    throw new Error(`atr(${period}) needs ${period + 1} candles, got ${candles.length}`);
  }
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const [, , high, low] = candles[i]!;
    const prevClose = candles[i - 1]![4];
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i]!;
  let out = sum / period;
  for (let i = period; i < tr.length; i++) out = (out * (period - 1) + tr[i]!) / period;
  return out;
}

/** Last candle's volume relative to the mean of the `lookback` candles before it. */
export function volumeRatio(candles: Candle[], lookback = 20): number {
  if (candles.length < lookback + 1) return 1;
  const last = candles[candles.length - 1]![5];
  let sum = 0;
  for (let i = candles.length - 1 - lookback; i < candles.length - 1; i++) sum += candles[i]![5];
  const mean = sum / lookback;
  return mean === 0 ? 1 : last / mean;
}

/**
 * Build the snapshot every lesson rule is evaluated against.
 *
 * `candles` must contain only CLOSED candles — ccxt's last OHLCV row is the
 * candle currently forming, and its volume/close change on every poll, which
 * would make rules fire and un-fire within the same hour.
 *
 * `price` is the live ticker price, used for grid decisions; the indicators
 * themselves are derived from closed candles.
 */
export function snapshot(candles: Candle[], price: number): IndicatorSnapshot {
  if (candles.length < MIN_CANDLES) {
    throw new Error(`snapshot needs at least ${MIN_CANDLES} closed candles, got ${candles.length}`);
  }
  const closes = candles.map((c) => c[4]);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atrAbs = atr(candles, 14);

  return {
    price,
    rsi14: rsi(closes, 14),
    atrPct: (atrAbs / price) * 100,
    ema20,
    ema50,
    emaSpreadPct: ((ema20 - ema50) / ema50) * 100,
    volumeRatio: volumeRatio(candles, 20),
    at: new Date().toISOString(),
  };
}
