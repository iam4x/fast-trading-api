export type BinanceMarket = {
  symbol: string;
  pair: string;
  contractType: string;
  deliveryDate: number;
  onboardDate: number;
  status: string;
  maintMarginPercent: string;
  requiredMarginPercent: string;
  baseAsset: string;
  quoteAsset: string;
  marginAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  baseAssetPrecision: number;
  quotePrecision: number;
  underlyingType: string;
  underlyingSubType: string[];
  triggerProtect: string;
  liquidationFee: string;
  marketTakeBound: string;
  maxMoveOrderLimit: 10000;
  filters: [
    {
      filterType: "PRICE_FILTER";
      minPrice: string;
      tickSize: string;
      maxPrice: string;
    },
    {
      filterType: "LOT_SIZE";
      maxQty: string;
      stepSize: string;
      minQty: string;
    },
    {
      filterType: "MARKET_LOT_SIZE";
      minQty: string;
      stepSize: string;
      maxQty: string;
    },
    {
      filterType: "MAX_NUM_ORDERS";
      limit: number;
    },
    {
      filterType: "MAX_NUM_ALGO_ORDERS";
      limit: number;
    },
    {
      filterType: "MIN_NOTIONAL";
      notional: number;
    },
    {
      filterType: "PERCENT_PRICE";
      multiplierDown: string;
      multiplierUp: string;
      multiplierDecimal: string;
    },
    {
      filterType: "POSITION_RISK_CONTROL";
      positionControlSide: string;
    },
  ];
  orderTypes: string[];
  timeInForce: string[];
  permissionSets: string[];
};

export type BinanceTicker24h = {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  weightedAvgPrice: string;
  lastPrice: string;
  lastQty: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  openTime: number;
  closeTime: number;
  firstId: number;
  lastId: number;
  count: number;
};

export type BinanceTickerBook = {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  time: number;
  lastUpdateId: number;
};

export type BinanceTickerPrice = {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice: string;
  lastFundingRate: string;
  interestRate: string;
  nextFundingTime: number;
  time: number;
};

export type BinanceAccount = {
  totalWalletBalance: string;
  availableBalance: string;
  totalInitialMargin: string;
  totalUnrealizedProfit: string;
  positions: Array<{
    symbol: string;
    initialMargin: string;
    maintMargin: string;
    unrealizedProfit: string;
    positionInitialMargin: string;
    openOrderInitialMargin: string;
    leverage: string;
    isolated: boolean;
    entryPrice: string;
    breakEvenPrice: string;
    maxNotional: string;
    positionSide: "LONG" | "SHORT" | "BOTH";
    positionAmt: string;
    notional: string;
    isolatedWallet: string;
    updateTime: number;
    bidNotional: string;
    askNotional: string;
  }>;
};
