export const RECV_WINDOW = 5000;
export const BROKER_ID = "f4f16f76ea9fBCDE";

export const OKX_ENDPOINTS = {
  PUBLIC: {
    MARKETS: "/api/v5/public/instruments",
    TICKERS: "/api/v5/market/tickers",
    KLINE: "/api/v5/market/candles",
  },
  PRIVATE: {
    ACCOUNT: "/api/v5/account/config",
    PARTNER: "/api/v5/users/partner/if-rebate",
    BALANCE: "/api/v5/account/account-position-risk",
    POSITIONS: "/api/v5/account/positions",
    UNFILLED_ORDERS: "/api/v5/trade/orders-pending",
    UNFILLED_ALGO_ORDERS: "/api/v5/trade/orders-algo-pending",
    CANCEL_ORDERS: "/api/v5/trade/cancel-batch-orders",
    CANCEL_ALGO_ORDERS: "/api/v5/trade/cancel-algos",
    PLACE_ORDERS: "/api/v5/trade/batch-orders",
    PLACE_ALGO_ORDER: "/api/v5/trade/order-algo",
    SET_LEVERAGE: "/api/v5/account/set-leverage",
    LEVERAGE: "/api/v5/account/leverage-info",
    SET_POSITION_MODE: "/api/v5/account/set-position-mode",
    ACCOUNT_CONFIG: "/api/v5/account/config",
    ACCOUNT_LEVEL: "/api/v5/account/set-account-level",
  },
};
