import type { BreakerConfig } from './core/breaker.ts';
import type { GridConfig } from './types.ts';

// Bun loads .env automatically.

function str(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${key}`);
  return v;
}

function num(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`Missing required env var: ${key}`);
    return fallback;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`Env var ${key} is not a number: ${raw}`);
  return v;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

export interface Config {
  grid: GridConfig;
  breaker: BreakerConfig;
  timeframe: string;
  pollIntervalMs: number;
  dryRun: boolean;
  testnet: boolean;
  exchange: { apiKey: string; secret: string };
  dataDir: string;
}

export function loadConfig(): Config {
  const grid: GridConfig = {
    symbol: str('SYMBOL', 'ETH/USDT'),
    upper: num('GRID_UPPER'),
    lower: num('GRID_LOWER'),
    step: num('GRID_STEP'),
    usdtPerLevel: num('USDT_PER_LEVEL'),
    maxOpenBids: num('MAX_OPEN_BIDS', 3),
  };

  if (grid.step <= 0) throw new Error('GRID_STEP must be > 0');
  if (grid.upper <= grid.lower) throw new Error('GRID_UPPER must be greater than GRID_LOWER');
  if (grid.usdtPerLevel <= 0) throw new Error('USDT_PER_LEVEL must be > 0');
  if (grid.maxOpenBids < 1) throw new Error('MAX_OPEN_BIDS must be >= 1');

  const breaker: BreakerConfig = {
    maxDrawdownUsdt: num('MAX_DRAWDOWN_USDT', 0), // 0 = off; depends on capital, opt in
    maxConsecutiveErrors: num('MAX_CONSECUTIVE_ERRORS', 5),
    maxPriceJumpPct: num('MAX_PRICE_JUMP_PCT', 0), // 0 = off
  };
  if (breaker.maxDrawdownUsdt < 0) throw new Error('MAX_DRAWDOWN_USDT must be >= 0');
  if (breaker.maxConsecutiveErrors < 0) throw new Error('MAX_CONSECUTIVE_ERRORS must be >= 0');
  if (breaker.maxPriceJumpPct < 0) throw new Error('MAX_PRICE_JUMP_PCT must be >= 0');

  const dryRun = bool('DRY_RUN', true);
  const testnet = bool('TESTNET', true);

  // Real money needs a deliberate step, not just two flipped booleans.
  if (!dryRun && !testnet && process.env.LIVE_CONFIRM !== 'i-understand-the-risk') {
    throw new Error(
      'Refusing to run live: DRY_RUN=false and TESTNET=false requires LIVE_CONFIRM=i-understand-the-risk',
    );
  }

  return {
    grid,
    breaker,
    timeframe: str('TIMEFRAME', '1h'),
    pollIntervalMs: num('POLL_INTERVAL_MS', 60_000),
    dryRun,
    testnet,
    exchange: {
      // Read-only endpoints work unauthenticated, so keys are optional in dry-run.
      apiKey: process.env.EXCHANGE_API_KEY ?? '',
      secret: process.env.EXCHANGE_SECRET ?? '',
    },
    dataDir: process.env.DATA_DIR ?? 'data',
  };
}

export function describeMode(cfg: Config): string {
  if (cfg.dryRun) return `DRY-RUN (no orders sent, fills simulated)${cfg.testnet ? ' + testnet feed' : ''}`;
  if (cfg.testnet) return 'TESTNET (real orders on Binance sandbox)';
  return 'LIVE (real orders, real money)';
}
