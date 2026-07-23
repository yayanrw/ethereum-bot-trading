/** Numeric fields of IndicatorSnapshot — the only things a lesson rule can test. */
export type Indicator =
  | 'price'
  | 'rsi14'
  | 'atrPct'
  | 'ema20'
  | 'ema50'
  | 'emaSpreadPct'
  | 'volumeRatio';

export interface IndicatorSnapshot {
  price: number;
  rsi14: number;
  /** ATR normalised as % of price, so thresholds survive a change in ETH's price level. */
  atrPct: number;
  ema20: number;
  ema50: number;
  /** (ema20 - ema50) / ema50 * 100 — positive means short-term trend is above long-term. */
  emaSpreadPct: number;
  /** last closed candle volume / mean volume of the previous 20 candles */
  volumeRatio: number;
  at: string;
}

export type ComparisonOp = '>' | '<' | '>=' | '<=' | '==';

export interface Condition {
  indicator: Indicator;
  op: ComparisonOp;
  value: number;
}

/** `block_entry` vetoes new buys. `hold_sell` keeps a lot past its +1 grid target. */
export type LessonAction = 'block_entry' | 'hold_sell';

export interface LessonEvidence {
  trades: number;
  winRate: number;
  avgPnlPct: number;
}

export interface Lesson {
  id: string;
  action: LessonAction;
  /** All conditions must hold for the rule to fire (AND). */
  when: Condition[];
  rationale: string;
  createdAt: string;
  evidence?: LessonEvidence;
}

export interface LessonsFile {
  version: number;
  updatedAt: string;
  rules: Lesson[];
}

/** One filled buy, tracked separately so it can be sold at its own exact quantity. */
export interface Lot {
  id: string;
  gridLevel: number;
  entryPrice: number;
  qty: number;
  costUsdt: number;
  openedAt: string;
  entryIndicators: IndicatorSnapshot;
  /** Resting sell order for this lot, if one is currently on the book. */
  sellOrderId?: string;
  /** Lesson id currently holding this lot past its target — used to log the hold once, not every tick. */
  heldBy?: string;
}

/** A resting buy order waiting at a grid level. */
export interface PendingBid {
  orderId: string;
  gridLevel: number;
  price: number;
  qty: number;
  placedAt: string;
  /** Market state when the bid was placed — carried onto the Lot when it fills. */
  placedIndicators: IndicatorSnapshot;
}

export interface PositionsFile {
  lots: Lot[];
  bids: PendingBid[];
  /** Lesson id currently blocking entry — used to log the block once, not every tick. */
  entryBlockedBy?: string;
}

export type DecisionType = 'entry_filled' | 'entry_blocked' | 'exit_filled' | 'exit_held';

export interface Decision {
  id: string;
  type: DecisionType;
  at: string;
  symbol: string;
  gridLevel: number;
  price: number;
  qty?: number;
  /** Market state at entry — the thing the evaluator correlates with the outcome. */
  indicators: IndicatorSnapshot;
  /** Market state at exit; present on exit_filled. */
  exitIndicators?: IndicatorSnapshot;
  /** Lesson id that vetoed this action (entry_blocked / exit_held only). */
  blockedBy?: string;
  lotId?: string;
  entryPrice?: number;
  pnlUsdt?: number;
  pnlPct?: number;
  holdingHours?: number;
}

export interface GridConfig {
  symbol: string;
  upper: number;
  lower: number;
  step: number;
  usdtPerLevel: number;
  /** How many empty levels below price to keep bids resting on. */
  maxOpenBids: number;
}

export interface PlaceBid {
  gridLevel: number;
  price: number;
  qty: number;
}

export interface PlaceSell {
  lot: Lot;
  targetLevel: number;
  price: number;
  qty: number;
}

/** Pure output of decideTick — index.ts turns this into exchange calls. */
export interface TickPlan {
  cancelBids: PendingBid[];
  placeBids: PlaceBid[];
  /** Lots whose resting sell must be pulled because a hold_sell rule now fires. */
  cancelSells: Lot[];
  placeSells: PlaceSell[];
  /**
   * One entry per lot with a live sell target. The caller stamps `lot.heldBy =
   * blockedBy` (undefined when not held) so a standing hold logs once, not once
   * per tick, and clears itself when the rule stops firing.
   */
  holdState: { lot: Lot; blockedBy?: string }[];
  /** Lesson id blocking entry this tick, persisted so the block logs once. */
  entryBlockedBy?: string;
  /** entry_blocked / exit_held records, ready to append to the decision log. */
  skipped: Decision[];
}

export interface RuleVerdict {
  allowed: boolean;
  blockedBy?: string;
  rationale?: string;
}
