export type BybitInstrument = {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  contractType: string;
  status: string;
  fundingInterval: number;
  lotSizeFilter: {
    qtyStep: string;
    minOrderQty: string;
    maxOrderQty: string;
    maxMktOrderQty: string;
    minNotionalValue: string;
    postOnlyMaxOrderQty: string;
  };
  leverageFilter: {
    minLeverage: string;
    maxLeverage: string;
  };
  priceFilter: {
    tickSize: string;
  };
};

export type BybitTicker = {
  ask1Price: string;
  ask1Size: string;
  basis: string;
  basisRate: string;
  bid1Price: string;
  bid1Size: string;
  curPreListingPhase: string;
  deliveryFeeRate: string;
  deliveryTime: string;
  fundingRate: string;
  highPrice24h: string;
  indexPrice: string;
  lastPrice: string;
  lowPrice24h: string;
  markPrice: string;
  nextFundingTime: string;
  openInterest: string;
  openInterestValue: string;
  preOpenPrice: string;
  preQty: string;
  predictedDeliveryPrice: string;
  prevPrice1h: string;
  prevPrice24h: string;
  price24hPcnt: string;
  symbol: string;
  turnover24h: string;
  volume24h: string;
};

export type BybitBalance = {
  totalEquity: string;
  accountIMRate: string;
  totalMarginBalance: string;
  totalInitialMargin: string;
  accountType: string;
  totalAvailableBalance: string;
  accountMMRate: string;
  totalPerpUPL: string;
  totalWalletBalance: string;
  accountLTV: string;
  totalMaintenanceMargin: string;
  coin: Record<string, string | number>[];
};

export type BybitPosition = {
  symbol: string;
  leverage: string;
  autoAddMargin: number;
  avgPrice: string;
  liqPrice: string;
  riskLimitValue: string;
  takeProfit: string;
  positionValue: string;
  isReduceOnly: false;
  tpslMode: string;
  riskId: number;
  trailingStop: string;
  unrealisedPnl: string;
  markPrice: string;
  adlRankIndicator: number;
  cumRealisedPnl: string;
  positionMM: string;
  createdTime: string;
  positionIdx: number;
  positionIM: string;
  seq: number;
  updatedTime: string;
  side: string;
  bustPrice: string;
  positionBalance: string;
  leverageSysUpdatedTime: string;
  curRealisedPnl: string;
  size: string;
  positionStatus: string;
  mmrSysUpdatedTime: string;
  stopLoss: string;
  tradeMode: number;
  sessionAvgPrice: string;
};

export type BybitWebsocketPosition = {
  positionIdx: number;
  tradeMode: number;
  riskId: number;
  riskLimitValue: string;
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  sessionAvgPrice: string;
  leverage: string;
  positionValue: string;
  positionBalance: string;
  markPrice: string;
  positionIM: string;
  positionMM: string;
  takeProfit: string;
  stopLoss: string;
  trailingStop: string;
  unrealisedPnl: string;
  cumRealisedPnl: string;
  curRealisedPnl: string;
  createdTime: string;
  updatedTime: string;
  tpslMode: string;
  liqPrice: string;
  bustPrice: string;
  category: string;
  positionStatus: string;
  adlRankIndicator: number;
  autoAddMargin: number;
  leverageSysUpdatedTime: string;
  mmrSysUpdatedTime: string;
  seq: number;
  isReduceOnly: boolean;
};

export type BybitOrder = {
  symbol: string;
  orderType: string;
  orderLinkId: string;
  slLimitPrice: string;
  orderId: string;
  cancelType: string;
  avgPrice: string;
  stopOrderType: string;
  lastPriceOnCreated: string;
  orderStatus: string;
  createType: string;
  takeProfit: string;
  cumExecValue: string;
  tpslMode: string;
  smpType: string;
  triggerDirection: number;
  blockTradeId: string;
  isLeverage: string;
  rejectReason: string;
  price: string;
  orderIv: string;
  createdTime: string;
  tpTriggerBy: string;
  positionIdx: number;
  timeInForce: string;
  leavesValue: string;
  updatedTime: string;
  side: string;
  smpGroup: number;
  triggerPrice: string;
  tpLimitPrice: string;
  cumExecFee: string;
  leavesQty: string;
  slTriggerBy: string;
  closeOnTrigger: false;
  placeType: string;
  cumExecQty: string;
  reduceOnly: false;
  qty: string;
  stopLoss: string;
  marketUnit: string;
  smpOrderId: string;
  triggerBy: string;
};

export type BybitPlaceOrderOpts = {
  symbol: string;
  side: "Buy" | "Sell";
  orderType: "Market" | "Limit" | "StopLoss" | "TakeProfit" | "TrailingStop";
  qty: string;
  price?: string;
  triggerDirection?: 1 | 2;
  triggerPrice?: string;
  triggerBy?: "LastPrice" | "IndexPrice" | "MarkPrice";
  timeInForce?: "GTC" | "FOK" | "IOC" | "PostOnly";
  positionIdx?: 0 | 1 | 2;
  takeProfit?: string;
  stopLoss?: string;
  tpTriggerBy?: "MarkPrice" | "IndexPrice" | "LastPrice";
  slTriggerBy?: "MarkPrice" | "IndexPrice" | "LastPrice";
  reduceOnly?: boolean;
  closeOnTrigger?: boolean;
  tpslMode?: "Full" | "Partial";
  tpLimitPrice?: string;
  slLimitPrice?: string;
  tpOrderType?: "Market" | "Limit";
  slOrderType?: "Market" | "Limit";
};

export type BybitBatchResponse<
  T extends string,
  D extends Record<string, any> = Record<string, any>,
> = {
  reqId: string;
  retMsg: string;
  op: T;
  data: D;
  retExtInfo: {
    list: Array<{
      code: number;
      msg: string;
    }>;
  };
};

export type BybitPlaceOrderBatchResponse = BybitBatchResponse<
  "order.create-batch",
  {
    list: Array<{
      category: string;
      symbol: string;
      orderId: string;
      orderLinkId: string;
      createdAt: string;
    }>;
  }
>;

export type BybitCancelOrderBatchResponse = BybitBatchResponse<
  "order.cancel-batch",
  {
    list: Array<{
      category: string;
      orderId: string;
      orderLinkId: string;
      symbol: string;
    }>;
  }
>;

export type BybitUpdateOrderBatchResponse =
  BybitBatchResponse<"order.amend-batch">;
