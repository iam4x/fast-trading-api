import {
  OrderSide,
  OrderStatus,
  OrderTimeInForce,
  OrderType,
  type Timeframe,
} from "~/types/lib.types";
import { inverseObj } from "~/utils/inverse-obj.utils";

export const RECV_WINDOW = 5000;
export const BROKER_ID = "Gi000266";
export const ORDER_BOOK_DEPTH = 1000;

export const BYBIT_ENDPOINTS = {
  PUBLIC: {
    MARKETS: "/v5/market/instruments-info",
    TICKERS: "/v5/market/tickers",
    KLINE: "/v5/market/kline",
  },
  PRIVATE: {
    POSITIONS: "/v5/position/list",
    BALANCE: "/v5/account/wallet-balance",
    ORDERS: "/v5/order/realtime",
    ORDERS_HISTORY: "/v5/order/history",
    TRADING_STOP: "/v5/position/trading-stop",
    SET_LEVERAGE: "/v5/position/set-leverage",
    CANCEL_ALL_ORDERS: "/v5/order/cancel-all",
  },
};

export const INTERVAL: Record<Timeframe, string> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "2h": "120",
  "4h": "240",
  "6h": "360",
  "12h": "720",
  "1d": "D",
  "1w": "W",
};

export const ORDER_STATUS: Record<string, OrderStatus> = {
  Created: OrderStatus.Open,
  New: OrderStatus.Open,
  Active: OrderStatus.Open,
  Untriggered: OrderStatus.Open,
  PartiallyFilled: OrderStatus.Open,
  Rejected: OrderStatus.Closed,
  Filled: OrderStatus.Filled,
  Deactivated: OrderStatus.Closed,
  Triggered: OrderStatus.Filled,
  PendingCancel: OrderStatus.Canceled,
  Cancelled: OrderStatus.Canceled,
};

export const ORDER_TYPE = {
  Limit: OrderType.Limit,
  Market: OrderType.Market,
  StopLoss: OrderType.StopLoss,
  TakeProfit: OrderType.TakeProfit,
  TrailingStop: OrderType.TrailingStopLoss,
};

export const ORDER_SIDE = {
  Buy: OrderSide.Buy,
  Sell: OrderSide.Sell,
};

export const ORDER_TIME_IN_FORCE = {
  GTC: OrderTimeInForce.GoodTillCancel,
  IOC: OrderTimeInForce.ImmediateOrCancel,
  FOK: OrderTimeInForce.FillOrKill,
  PostOnly: OrderTimeInForce.PostOnly,
};

export const ORDER_TIME_IN_FORCE_INVERSE = inverseObj(ORDER_TIME_IN_FORCE);
export const ORDER_SIDE_INVERSE = inverseObj(ORDER_SIDE);
export const ORDER_TYPE_INVERSE = inverseObj(ORDER_TYPE);
