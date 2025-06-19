import type { ObjectChangeCommand, ObjectPaths } from "./misc.types";

export interface FastTradingApiOptions {
  accounts: Account[];
  config?: Partial<Record<ExchangeName, Partial<ExchangeConfig>>>;
  store?: Store;
}

export interface ExchangeConfig {
  PUBLIC_API_URL: string;
  PRIVATE_API_URL: string;
  WS_PUBLIC_URL: string;
  WS_PRIVATE_URL: string;
  WS_TRADE_URL: string;
  options?: Record<string, any>;
}

export interface Store {
  memory: StoreMemory;
  reset(): void;
  applyChanges<P extends ObjectPaths<StoreMemory>>(
    changes: ObjectChangeCommand<StoreMemory, P>[],
  ): void;
}

export interface StoreMemory extends Record<ExchangeName, ExchangeMemory> {}

export interface ExchangeMemory {
  loaded: {
    markets: boolean;
    tickers: boolean;
  };
  private: Record<Account["id"], ExchangeAccountMemory>;
  public: {
    latency: number;
    tickers: Record<string, Ticker>;
    markets: Record<string, Market>;
  };
}

export interface ExchangeAccountMemory {
  balance: Balance;
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  notifications: Notification[];
  twaps: TWAPState[];
  chases: ChaseState[];
  metadata: {
    leverage: Record<string, number>;
    hedgedPosition: Record<string, boolean>;
  };
}

export interface FetchOHLCVParams {
  symbol: string;
  timeframe: Timeframe;
  from?: number;
  to?: number;
  limit?: number;
}

export enum ExchangeName {
  BYBIT = "bybit",
  HL = "hyperliquid",
  BINANCE = "binance",
}

export interface Account {
  id: string;
  exchange: ExchangeName;
  apiKey: string;
  apiSecret: string;
  vaultAddress?: string;
}

export interface Balance {
  used: number;
  free: number;
  total: number;
  upnl: number;
}

export interface Ticker {
  id: string | number;
  exchange: ExchangeName;
  symbol: string;
  cleanSymbol: string;
  bid: number;
  ask: number;
  last: number;
  mark: number;
  index: number;
  percentage: number;
  openInterest: number;
  fundingRate: number;
  volume: number;
  quoteVolume: number;
}

export interface Market {
  id: string | number;
  exchange: ExchangeName;
  symbol: string;
  base: string;
  quote: string;
  active: boolean;
  precision: {
    amount: number;
    price: number;
  };
  limits: {
    amount: {
      min: number;
      max: number;
      maxMarket: number;
    };
    leverage: {
      min: number;
      max: number;
    };
  };
}

export enum PositionSide {
  Long = "long",
  Short = "short",
}

export interface Position {
  exchange: ExchangeName;
  accountId: string;
  symbol: string;
  side: PositionSide;
  entryPrice: number;
  notional: number;
  leverage: number;
  upnl: number;
  rpnl: number;
  contracts: number;
  liquidationPrice: number;
  isHedged?: boolean;
}

export enum OrderStatus {
  Open = "open",
  Filled = "filled",
  Closed = "closed",
  Canceled = "canceled",
}

export enum OrderType {
  Market = "market",
  Limit = "limit",
  StopLoss = "stop_market",
  TakeProfit = "take_profit_market",
  TrailingStopLoss = "trailing_stop_market",
}

export enum OrderSide {
  Buy = "buy",
  Sell = "sell",
}

export enum OrderTimeInForce {
  GoodTillCancel = "GoodTillCancel",
  ImmediateOrCancel = "ImmediateOrCancel",
  FillOrKill = "FillOrKill",
  PostOnly = "PostOnly",
}

export interface Order {
  id: string | number;
  exchange: ExchangeName;
  accountId: string;
  parentId?: string;
  status: OrderStatus;
  symbol: string;
  type: OrderType;
  side: OrderSide;
  price: number;
  amount: number;
  filled: number;
  remaining: number;
  reduceOnly: boolean;
  timestamp: number;
}

export interface Fill {
  symbol: string;
  side: OrderSide;
  price: number;
  amount: number;
  timestamp: number;
}

export interface OrderBookOrder {
  price: number;
  amount: number;
  total: number;
}

export interface OrderBook {
  bids: OrderBookOrder[];
  asks: OrderBookOrder[];
}

export type Notification = {
  id: string;
  accountId: Account["id"];
  type: "order_fill";
  data: {
    id: string | number;
    side: OrderSide;
    amount: number;
    symbol: Order["symbol"];
    price: number | "MARKET";
  };
};

export type Timeframe =
  | "1d"
  | "1h"
  | "1m"
  | "1w"
  | "2h"
  | "3m"
  | "4h"
  | "5m"
  | "6h"
  | "12h"
  | "15m"
  | "30m";

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PlaceOrderOpts {
  symbol: string;
  type: OrderType;
  side: OrderSide;
  amount: number;
  price?: number;
  reduceOnly: boolean;
  timeInForce?: OrderTimeInForce;
}

export interface UpdateOrderOpts {
  order: Order;
  update: { amount: number } | { price: number };
}

export interface PlacePositionStopOpts {
  type: OrderType.StopLoss | OrderType.TrailingStopLoss | OrderType.TakeProfit;
  price: number;
}

export interface TWAPOpts {
  symbol: string;
  amount: number;
  side: OrderSide;
  duration: number;
  lotsCount: number;
  randomness: number;
  reduceOnly: boolean;
  limitOrders?: boolean;
  pauseInProfit?: boolean;
}

export enum TWAPStatus {
  Running = "running",
  Paused = "paused",
}

export interface TWAPState {
  id: string;
  accountId: string;
  symbol: string;
  amount: number;
  amountExecuted: number;
  lots: number[];
  side: OrderSide;
  status: TWAPStatus;
  lotsCount: number;
  lotsExecuted: number;
  nextOrderAt: number;
}

export interface ChaseOpts {
  symbol: string;
  amount: number;
  side: OrderSide;
  min: number;
  max: number;
  distance: number;
  reduceOnly: boolean;
  stalk?: boolean;
  infinite?: boolean;
}

export interface ChaseState {
  id: string;
  accountId: string;
  side: OrderSide;
  symbol: string;
  max: number;
  min: number;
  amount: number;
  price: number;
  stalk?: boolean;
}
