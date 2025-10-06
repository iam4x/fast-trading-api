import { BaseWorker } from "../base.worker";

import {
  cancelBinanceOrders,
  cancelBinanceSymbolOrders,
  fetchBinanceAccount,
  fetchBinanceLeverageBracket,
  fetchBinanceMarkets,
  fetchBinanceOHLCV,
  fetchBinanceOrders,
  fetchBinanceOrdersHistory,
  fetchBinanceSymbolPositions,
  fetchBinanceTickers,
  placeBinanceOrderBatch,
  placeBinanceTradingStop,
  setBinanceLeverage,
} from "./binance.resolver";
import { BinanceWsPublic } from "./binance.ws-public";
import { BinanceWsPrivate } from "./binance.ws-private";
import { ORDER_SIDE, ORDER_TYPE, TIME_IN_FORCE } from "./binance.config";

import { omit } from "~/utils/omit.utils";
import {
  ExchangeName,
  OrderSide,
  OrderTimeInForce,
  OrderType,
  PositionSide,
  type Account,
  type ExchangeConfig,
  type FetchOHLCVParams,
  type PlaceOrderOpts,
  type PlacePositionStopOpts,
  type Position,
  type Timeframe,
} from "~/types/lib.types";
import { DEFAULT_CONFIG } from "~/config";
import { groupBy } from "~/utils/group-by.utils";
import { mapObj } from "~/utils/map-obj.utils";
import { chunk } from "~/utils/chunk.utils";
import { uniq } from "~/utils/uniq.utils";
import { adjust } from "~/utils/safe-math.utils";
import { inverseObj } from "~/utils/inverse-obj.utils";
import { genId } from "~/utils/gen-id.utils";
import { omitUndefined } from "~/utils/omit-undefined.utils";
import { times } from "~/utils/times.utils";

export class BinanceWorker extends BaseWorker {
  publicWs: BinanceWsPublic | null = null;

  pollBalancePositionsTimeouts: Record<Account["id"], NodeJS.Timeout> = {};
  privateWs: Record<Account["id"], BinanceWsPrivate> = {};

  async start({
    accounts,
    config,
    requestId,
  }: {
    accounts: Account[];
    config: ExchangeConfig;
    requestId: string;
  }) {
    await super.start({ accounts, requestId, config });
    await this.fetchPublic();
    this.emitResponse({ requestId });
  }

  stop() {
    this.publicWs?.stop();
    this.publicWs = null;

    for (const key in this.pollBalancePositionsTimeouts) {
      clearTimeout(this.pollBalancePositionsTimeouts[key]);
      delete this.pollBalancePositionsTimeouts[key];
    }
  }

  async fetchPublic() {
    const [markets, tickers] = await Promise.all([
      fetchBinanceMarkets(this.config),
      fetchBinanceTickers(this.config),
    ]);

    this.emitChanges([
      { type: "update", path: "loaded.markets", value: true },
      { type: "update", path: "loaded.tickers", value: true },
      { type: "update", path: "public.markets", value: markets },
      {
        type: "update",
        path: "public.tickers",
        value: omit(
          tickers,
          Object.keys(tickers).filter((t) => !markets[t]),
        ),
      },
    ]);

    this.log(`Loaded ${Object.keys(markets).length} Binance markets`);

    // 2. Start public WebSocket
    this.publicWs = new BinanceWsPublic({ parent: this });
  }

  async addAccounts({
    accounts,
    requestId,
  }: {
    accounts: Account[];
    requestId?: string;
  }) {
    super.addAccounts({ accounts, requestId });

    await Promise.all(
      accounts.map(async (account) => {
        await this.fetchAndPollBalancePositions(account);
        this.log(
          `Loaded Binance balance & positions for account [${account.id}]`,
        );
      }),
    );

    for (const account of accounts) {
      // Start listening on private data updates
      // as we have fetched the initial data from HTTP API
      this.privateWs[account.id] = new BinanceWsPrivate({
        parent: this,
        account,
      });

      // Then we fetch orders per account
      const orders = await fetchBinanceOrders({
        config: this.config,
        account,
      });

      this.log(
        `Loaded ${orders.length} Binance active orders for account [${account.id}]`,
      );

      this.emitChanges([
        {
          type: "update",
          path: `private.${account.id}.orders`,
          value: orders,
        },
      ]);

      // Then we fetch leverage bracket
      const leverageBrackets = await fetchBinanceLeverageBracket({
        config: this.config,
        account,
      });

      this.emitChanges([
        {
          type: "update",
          path: `private.${account.id}.metadata.maxLeveragePerSymbol`,
          value: leverageBrackets,
        },
      ]);

      // Then we fetch orders history
      const ordersHistory = await fetchBinanceOrdersHistory({
        config: this.config,
        account,
      });

      this.log(
        `Loaded ${ordersHistory.length} Binance orders history for account [${account.id}]`,
      );

      this.emitChanges([
        {
          type: "update",
          path: `private.${account.id}.fills`,
          value: ordersHistory,
        },
      ]);
    }

    if (requestId) {
      this.emitResponse({ requestId });
    }
  }

  async removeAccount({
    accountId,
    requestId,
  }: {
    accountId: string;
    requestId: string;
  }) {
    if (accountId in this.pollBalancePositionsTimeouts) {
      clearTimeout(this.pollBalancePositionsTimeouts[accountId]);
      delete this.pollBalancePositionsTimeouts[accountId];
    }

    await super.removeAccount({ accountId, requestId });
  }

  fetchAndPollBalancePositions = async (account: Account) => {
    const { balance, positions } = await fetchBinanceAccount({
      config: this.config,
      account,
    });

    const supportedPositions = positions.filter(
      (p) => p.symbol in this.memory.public.markets,
    );

    this.emitChanges([
      {
        type: "update",
        path: `private.${account.id}.positions`,
        value: supportedPositions,
      },
      {
        type: "update",
        path: `private.${account.id}.balance`,
        value: balance,
      },
    ]);

    this.pollBalancePositionsTimeouts[account.id] = setTimeout(
      () => this.fetchAndPollBalancePositions(account),
      5000,
    );
  };

  listenOrderBook(symbol: string) {
    this.publicWs?.listenOrderBook(symbol);
  }

  unlistenOrderBook(symbol: string) {
    this.publicWs?.unlistenOrderBook(symbol);
  }

  async fetchOHLCV({
    requestId,
    params,
  }: {
    requestId: string;
    params: FetchOHLCVParams;
  }) {
    const candles = await fetchBinanceOHLCV({ config: this.config, params });
    this.emitResponse({ requestId, data: candles });
  }

  listenOHLCV(opts: { symbol: string; timeframe: Timeframe }) {
    this.publicWs?.listenOHLCV(opts);
  }

  unlistenOHLCV(opts: { symbol: string; timeframe: Timeframe }) {
    this.publicWs?.unlistenOHLCV(opts);
  }

  async setLeverage({
    requestId,
    accountId,
    symbol,
    leverage,
  }: {
    requestId: string;
    accountId: string;
    symbol: string;
    leverage: number;
  }) {
    const account = this.accounts.find((a) => a.id === accountId);

    if (!account) {
      this.error(`No account found for id: ${accountId}`);
      return;
    }

    const maxLeverage =
      this.memory.private[accountId].metadata.maxLeveragePerSymbol[symbol];

    const leverageWithinBounds = Math.min(
      Math.max(leverage, maxLeverage),
      maxLeverage,
    );

    const success = await setBinanceLeverage({
      config: this.config,
      account,
      symbol,
      leverage: leverageWithinBounds,
    });

    if (success) {
      this.emitChanges([
        {
          type: `update`,
          path: `private.${accountId}.metadata.leverage.${symbol}`,
          value: leverage,
        },
      ]);
    }

    this.emitResponse({ requestId, data: success });
  }

  async cancelOrders({
    orderIds,
    accountId,
    requestId,
  }: {
    orderIds: string[];
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    const account = this.accounts.find((a) => a.id === accountId);

    if (!account) {
      this.error(`No account found for id: ${accountId}`);
      return;
    }

    const orders = this.mapAccountOrdersFromIds({ orderIds, accountId });

    if (orders.length > 0) {
      const groupedBySymbol = groupBy(orders, (o) => o.symbol);
      const requests = mapObj(groupedBySymbol, (symbol, orders) => {
        return {
          symbol,
          origClientOrderIdList: orders.map((o) => o.id),
        };
      });

      for (const request of requests) {
        const lots = chunk(request.origClientOrderIdList, 10);

        for (const lot of lots) {
          await cancelBinanceOrders({
            config: this.config,
            account,
            symbol: request.symbol,
            origClientOrderIdList: lot,
          });
        }
      }
    }

    this.emitResponse({ requestId, data: [] });
  }

  async cancelAllOrders({
    accountId,
    requestId,
  }: {
    accountId: string;
    requestId: string;
  }) {
    const account = this.accounts.find((a) => a.id === accountId);

    if (!account) {
      this.error(`No account found for id: ${accountId}`);
      return;
    }

    const symbols = uniq(
      this.memory.private[accountId].orders.map((o) => o.symbol),
    );

    for (const symbol of symbols) {
      await cancelBinanceSymbolOrders({
        config: this.config,
        account,
        symbol,
      });
    }

    this.emitResponse({ requestId, data: [] });
  }

  async cancelSymbolOrders({
    symbol,
    accountId,
    requestId,
  }: {
    symbol: string;
    accountId: string;
    requestId: string;
  }) {
    const account = this.accounts.find((a) => a.id === accountId);

    if (!account) {
      this.error(`No account found for id: ${accountId}`);
      return;
    }

    await cancelBinanceSymbolOrders({ config: this.config, account, symbol });

    this.emitResponse({ requestId, data: [] });
  }

  async fetchPositionMetadata({
    requestId,
    accountId,
    symbol,
  }: {
    requestId: string;
    accountId: string;
    symbol: string;
  }) {
    const account = this.accounts.find((a) => a.id === accountId);

    if (!account) {
      this.error(`No account found for id: ${accountId}`);
      return;
    }

    const positions = await fetchBinanceSymbolPositions({
      config: this.config,
      account,
      symbol,
    });

    const leverage = positions[0]?.leverage ?? 1;
    const isHedged = positions.some((p) => p.isHedged);

    this.emitChanges([
      {
        type: `update`,
        path: `private.${accountId}.metadata.leverage.${symbol}`,
        value: leverage,
      },
      {
        type: `update`,
        path: `private.${accountId}.metadata.hedgedPosition.${symbol}`,
        value: isHedged,
      },
    ]);

    this.emitResponse({ requestId, data: { leverage, isHedged } });
  }

  async placeOrders({
    orders,
    accountId,
    requestId,
  }: {
    orders: PlaceOrderOpts[];
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    const account = this.accounts.find((a) => a.id === accountId);

    if (!account) {
      this.error(`No account found for id: ${accountId}`);
      return [];
    }

    const payloads = orders.flatMap((o) =>
      this.formatCreateOrder({ opts: o, accountId }),
    );

    const { orderIds, errors } = await placeBinanceOrderBatch({
      config: this.config,
      account,
      payloads,
    });

    for (const error of errors) {
      this.error(`Binance place order error: ${error}`);
    }

    this.emitResponse({ requestId, data: orderIds });

    return orderIds;
  }

  async placePositionStop({
    position,
    stop,
    requestId,
  }: {
    position: Position;
    stop: PlacePositionStopOpts;
    requestId: string;
    priority?: boolean;
  }) {
    const account = this.accounts.find((a) => a.id === position.accountId);

    if (!account) {
      this.error(`No account found for id: ${position.accountId}`);
      return;
    }

    const stopOrder: Record<string, any> = {
      newClientOrderId: genId(),
      symbol: position.symbol,
      side: inverseObj(ORDER_SIDE)[
        position.side === PositionSide.Long ? OrderSide.Sell : OrderSide.Buy
      ],
      positionSide: this.getOrderPositionSide({
        accountId: account.id,
        opts: {
          symbol: position.symbol,
          side:
            position.side === PositionSide.Long
              ? OrderSide.Sell
              : OrderSide.Buy,
          type: stop.type,
          reduceOnly: true,
        },
      }),
      type: inverseObj(ORDER_TYPE)[stop.type],
      closePosition: "true",
      stopPrice: stop.price,
    };

    if (stop.type === OrderType.TrailingStopLoss) {
      const market = this.memory.public.markets[position.symbol];
      const ticker = this.memory.public.tickers[position.symbol];

      if (!market) {
        this.error(`No market found for symbol: ${position.symbol}`);
        this.emitResponse({ requestId, data: [] });
        return;
      }

      if (!ticker) {
        this.error(`No ticker found for symbol: ${position.symbol}`);
        this.emitResponse({ requestId, data: [] });
        return;
      }

      const priceDistance = adjust(
        Math.max(ticker.last, stop.price) - Math.min(ticker.last, stop.price),
        market.precision.price,
      );

      const distancePercentage =
        Math.round(((priceDistance * 100) / ticker.last) * 10) / 10;

      delete stopOrder.closePosition;
      stopOrder.priceProtect = "true";
      stopOrder.quantity = `${position.contracts}`;
      stopOrder.callbackRate = `${distancePercentage}`;
    }

    await placeBinanceTradingStop({
      config: this.config,
      account,
      stopOrder,
    });

    this.emitResponse({ requestId, data: [] });
  }

  formatCreateOrder = ({
    opts,
    accountId,
  }: {
    opts: PlaceOrderOpts;
    accountId: string;
  }) => {
    const market = this.memory.public.markets[opts.symbol];

    if (!market) {
      this.error(`No market found for symbol: ${opts.symbol}`);
      return [];
    }

    const isStopOrTP =
      opts.type === OrderType.StopLoss || opts.type === OrderType.TakeProfit;

    const pSide = this.getOrderPositionSide({ opts, accountId });

    const maxSize = market.limits.amount.max;
    const pPrice = market.precision.price;

    const pAmount = market.precision.amount;
    const amount = adjust(opts.amount, pAmount);

    // We use price only for limit orders
    // Market order should not define price
    const price =
      opts.price && opts.type !== OrderType.Market
        ? adjust(opts.price, pPrice)
        : undefined;

    // Binance stopPrice only for SL or TP orders
    const priceField = isStopOrTP ? "stopPrice" : "price";

    const timeInForce = opts.timeInForce
      ? inverseObj(TIME_IN_FORCE)[opts.timeInForce]
      : inverseObj(TIME_IN_FORCE)[OrderTimeInForce.GoodTillCancel];

    const req = omitUndefined({
      symbol: opts.symbol,
      positionSide: pSide,
      side: inverseObj(ORDER_SIDE)[opts.side],
      type: inverseObj(ORDER_TYPE)[opts.type],
      quantity: amount ? `${amount}` : undefined,
      [priceField]: price ? `${price}` : undefined,
      timeInForce: opts.type === OrderType.Limit ? timeInForce : undefined,
      closePosition: isStopOrTP ? "true" : undefined,
      reduceOnly: opts.reduceOnly && !isStopOrTP ? "true" : undefined,
    });

    const lots = amount > maxSize ? Math.ceil(amount / maxSize) : 1;
    const rest = amount > maxSize ? adjust(amount % maxSize, pAmount) : 0;

    const lotSize = adjust((amount - rest) / lots, pAmount);

    const payloads: Array<Record<string, any>> = times(lots, () => ({
      ...req,
      quantity: `${lotSize}`,
    }));

    if (rest) {
      payloads.push({ ...req, quantity: `${rest}` });
    }

    // We need to set orderId for each order
    // otherwise Binance will duplicate the IDs
    // when its sent in batches
    for (const payload of payloads) {
      payload.newClientOrderId = genId();
    }

    return payloads;
  };

  getOrderPositionSide = ({
    opts,
    accountId,
  }: {
    opts: {
      symbol: string;
      side: OrderSide;
      type: OrderType;
      reduceOnly: boolean;
    };
    accountId: string;
  }) => {
    let positionSide = "BOTH";

    // We need to specify side of the position to interract with
    // if we are in hedged mode on the binance account
    if (this.memory.private[accountId].metadata.hedgedPosition[opts.symbol]) {
      positionSide = opts.side === OrderSide.Buy ? "LONG" : "SHORT";

      if (
        opts.type === OrderType.StopLoss ||
        opts.type === OrderType.TakeProfit ||
        opts.type === OrderType.TrailingStopLoss ||
        opts.reduceOnly
      ) {
        positionSide = positionSide === "LONG" ? "SHORT" : "LONG";
      }
    }

    return positionSide;
  };
}

new BinanceWorker({
  name: ExchangeName.BINANCE,
  config: DEFAULT_CONFIG[ExchangeName.BINANCE],
  parent: self,
});
