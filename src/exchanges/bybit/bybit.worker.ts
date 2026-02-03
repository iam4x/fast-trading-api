import { BaseWorker } from "../base.worker";

import { BybitWsPublic } from "./bybit.ws-public";
import { BybitWsPrivate } from "./bybit.ws-private";
import {
  fetchBybitOrders,
  fetchBybitBalance,
  fetchBybitMarkets,
  fetchBybitPositions,
  fetchBybitTickers,
  fetchBybitOHLCV,
  createBybitTradingStop,
  fetchBybitSymbolPositions,
  setBybitLeverage,
  fetchBybitOrdersHistory,
  cancelAllBybitOrders,
  cancelSymbolBybitOrders,
} from "./bybit.resolver";
import type { BybitOrder } from "./bybit.types";
import {
  formatMarkerOrLimitOrder,
  mapBybitFill,
  mapBybitOrder,
} from "./bybit.utils";
import { BybitWsTrading } from "./bybit.ws-trading";

import {
  ExchangeName,
  OrderType,
  type Account,
  type PlaceOrderOpts,
  type Timeframe,
  type FetchOHLCVParams,
  type ExchangeConfig,
  type UpdateOrderOpts,
  type PlacePositionStopOpts,
  type Position,
  PositionSide,
  OrderSide,
} from "~/types/lib.types";
import { partition } from "~/utils/partition.utils";
import { adjust, subtract } from "~/utils/safe-math.utils";
import { omit } from "~/utils/omit.utils";
import { toUSD } from "~/utils/to-usd.utils";
import { sumBy } from "~/utils/sum-by.utils";
import { genId } from "~/utils/gen-id.utils";
import { DEFAULT_EXCHANGES_CONFIG } from "~/exchanges/exchanges.config";

export class BybitWorker extends BaseWorker {
  publicWs: BybitWsPublic | null = null;
  privateWs: Record<Account["id"], BybitWsPrivate> = {};
  tradingWs: Record<Account["id"], BybitWsTrading> = {};

  pollBalanceTimeouts: Record<Account["id"], NodeJS.Timeout> = {};

  async start({
    accounts,
    config,
    requestId,
  }: {
    accounts: Account[];
    config: ExchangeConfig;
    requestId: string;
  }) {
    await this.fetchPublic();
    await super.start({ accounts, requestId, config });
    this.emitResponse({ requestId });
  }

  stop() {
    this.publicWs?.stop();
    this.publicWs = null;

    for (const key in this.privateWs) {
      this.privateWs[key].stop();
      delete this.privateWs[key];
    }

    for (const key in this.tradingWs) {
      this.tradingWs[key].stop();
      delete this.tradingWs[key];
    }

    for (const key in this.pollBalanceTimeouts) {
      clearTimeout(this.pollBalanceTimeouts[key]);
      delete this.pollBalanceTimeouts[key];
    }
  }

  async fetchPublic() {
    // 1. Fetch markets and tickers
    const [markets, tickers] = await Promise.all([
      fetchBybitMarkets(this.config),
      fetchBybitTickers({ config: this.config }),
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

    this.log(`Loaded ${Object.keys(markets).length} Bybit markets`);

    // 2. Start public websocket
    this.publicWs = new BybitWsPublic({ parent: this });
  }

  async addAccounts({
    accounts,
    requestId,
  }: {
    accounts: Account[];
    requestId?: string;
  }) {
    super.addAccounts({ accounts, requestId });

    for (const account of accounts) {
      this.tradingWs[account.id] = new BybitWsTrading({
        parent: this,
        account,
      });

      this.privateWs[account.id] = new BybitWsPrivate({
        parent: this,
        account,
      });
    }

    await Promise.all(
      accounts.map(async (account) => {
        await this.fetchAndPollBalance(account);
        this.log(`Loaded Bybit balance for account [${account.id}]`);
      }),
    );

    await Promise.all(
      accounts.map(async (account) => {
        const positions = await fetchBybitPositions({
          config: this.config,
          account,
          markets: this.memory.public.markets,
        });

        this.emitChanges([
          {
            type: "update",
            path: `private.${account.id}.positions`,
            value: positions,
          },
          {
            type: "update",
            path: `private.${account.id}.balance.upnl`,
            value: toUSD(sumBy(positions, "upnl")),
          },
          {
            type: "update",
            path: `private.${account.id}.metadata.leverage`,
            value: Object.fromEntries(
              positions.map((p) => [p.symbol, p.leverage]),
            ),
          },
          {
            type: "update",
            path: `private.${account.id}.metadata.hedgedPosition`,
            value: Object.fromEntries(
              positions.map((p) => [p.symbol, p.isHedged ?? false]),
            ),
          },
        ]);

        this.log(
          `Loaded ${positions.length} Bybit positions for account [${account.id}]`,
        );
      }),
    );

    for (const account of accounts) {
      // Start listening on private data updates
      // as we have fetched the initial data from HTTP API
      this.privateWs[account.id].startListening();

      // We delay fetch orders, as its no mandatory to start trading
      // TODO: replay orders update received after initial orders data?
      this.privateWs[account.id].startOrderBuffering();

      let hasEmittedOrders = false;
      const orders = await fetchBybitOrders({
        config: this.config,
        account,
        onOrdersUpdate: (partialOrders) => {
          hasEmittedOrders = true;
          this.emitChanges([
            {
              type: "update",
              path: `private.${account.id}.orders`,
              value: partialOrders,
            },
          ]);
        },
      });

      this.log(
        `Loaded ${orders.length} Bybit active orders for account [${account.id}]`,
      );

      if (!hasEmittedOrders) {
        this.emitChanges([
          {
            type: "update",
            path: `private.${account.id}.orders`,
            value: orders,
          },
        ]);
      }

      this.privateWs[account.id].flushOrderBuffer();

      // Then we fetch orders history, its not as essential as orders
      const ordersHistory = await fetchBybitOrdersHistory({
        config: this.config,
        account,
      });

      this.log(
        `Loaded ${ordersHistory.length} Bybit orders history for account [${account.id}]`,
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
    if (accountId in this.privateWs) {
      this.privateWs[accountId].stop();
      delete this.privateWs[accountId];
    }

    if (accountId in this.tradingWs) {
      this.tradingWs[accountId].stop();
      delete this.tradingWs[accountId];
    }

    if (accountId in this.pollBalanceTimeouts) {
      clearTimeout(this.pollBalanceTimeouts[accountId]);
      delete this.pollBalanceTimeouts[accountId];
    }

    await super.removeAccount({ accountId, requestId });
  }

  async fetchAndPollBalance(account: Account) {
    const balance = await fetchBybitBalance({
      config: this.config,
      account,
    });

    this.emitChanges([
      {
        type: "update",
        path: `private.${account.id}.balance`,
        value: balance,
      },
    ]);

    this.pollBalanceTimeouts[account.id] = setTimeout(
      () => this.fetchAndPollBalance(account),
      5000,
    );
  }

  updateAccountOrders({
    accountId,
    bybitOrders,
  }: {
    accountId: Account["id"];
    bybitOrders: BybitOrder[];
  }) {
    for (const bybitOrder of bybitOrders) {
      const orders = mapBybitOrder({ accountId, order: bybitOrder });

      const price = parseFloat(bybitOrder.price);
      const amount = parseFloat(bybitOrder.qty);

      if (bybitOrder.orderStatus === "PartiallyFilled") {
        // False positive when order is replaced
        // it emits a partially filled with 0 amount & price
        if (price <= 0 && amount <= 0) return;
      }

      if (
        bybitOrder.orderStatus === "Filled" ||
        bybitOrder.orderStatus === "PartiallyFilled"
      ) {
        const existingOrder = this.memory.private[accountId].orders.find(
          (o) => o.id === orders[0].id,
        );

        const amount = existingOrder
          ? subtract(parseFloat(bybitOrder.cumExecQty), existingOrder.filled)
          : parseFloat(bybitOrder.cumExecQty);

        this.emitChanges([
          {
            type: "update",
            path: `private.${accountId}.notifications.${this.memory.private[accountId].notifications.length}`,
            value: {
              id: genId(),
              accountId,
              type: "order_fill",
              data: {
                id: orders[0].id,
                symbol: orders[0].symbol,
                side: orders[0].side,
                price: orders[0].price || "MARKET",
                amount,
              },
            },
          },
        ]);
      }

      if (
        bybitOrder.orderStatus === "Cancelled" ||
        bybitOrder.orderStatus === "Deactivated" ||
        bybitOrder.orderStatus === "Filled"
      ) {
        const changes = this.memory.private[accountId].orders.reduce<
          {
            type: "removeArrayElement";
            path: `private.${typeof accountId}.orders`;
            index: number;
          }[]
        >((acc, o) => {
          if (
            o.id === orders[0].id ||
            o.id === `${orders[0].id}__stop_loss` ||
            o.id === `${orders[0].id}__take_profit`
          ) {
            acc.push({
              type: "removeArrayElement",
              path: `private.${accountId}.orders`,
              index:
                this.memory.private[accountId].orders.indexOf(o) - acc.length,
            });
          }

          return acc;
        }, []);

        this.emitChanges(changes);
      }

      if (bybitOrder.orderStatus === "Filled") {
        const fillsLength = this.memory.private[accountId].fills.length;

        this.emitChanges([
          {
            type: "update",
            path: `private.${accountId}.fills.${fillsLength}`,
            value: mapBybitFill(bybitOrder),
          },
        ]);
      }

      if (
        bybitOrder.orderStatus === "New" ||
        bybitOrder.orderStatus === "Untriggered" ||
        bybitOrder.orderStatus === "PartiallyFilled"
      ) {
        const [updateOrders, addOrders] = partition(orders, (order) =>
          this.memory.private[accountId].orders.some((o) => o.id === order.id),
        );

        const updateOrdersChanges = updateOrders.map((order) => {
          const idx = this.memory.private[accountId].orders.findIndex(
            (o) => o.id === order.id,
          );

          return {
            type: "update" as const,
            path: `private.${accountId}.orders.${idx}` as const,
            value: order,
          };
        });

        const ordersLength = this.memory.private[accountId].orders.length;
        const addOrdersChanges = addOrders.map((order, idx) => ({
          type: "update" as const,
          path: `private.${accountId}.orders.${ordersLength + idx}` as const,
          value: order,
        }));

        this.emitChanges([...updateOrdersChanges, ...addOrdersChanges]);
      }
    }
  }

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
    const candles = await fetchBybitOHLCV({ config: this.config, params });
    this.emitResponse({ requestId, data: candles });
  }

  listenOHLCV({ symbol, timeframe }: { symbol: string; timeframe: Timeframe }) {
    this.publicWs?.listenOHLCV({ symbol, timeframe });
  }

  unlistenOHLCV({
    symbol,
    timeframe,
  }: {
    symbol: string;
    timeframe: Timeframe;
  }) {
    this.publicWs?.unlistenOHLCV({ symbol, timeframe });
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

    const stopOrder = {
      symbol: position.symbol,
      type: stop.type,
      side:
        position.side === PositionSide.Long ? OrderSide.Sell : OrderSide.Buy,
      amount: position.contracts,
      price: stop.price,
      reduceOnly: true,
    };

    await createBybitTradingStop({
      config: this.config,
      order: stopOrder,
      account,
      market: this.memory.public.markets[position.symbol],
      ticker: this.memory.public.tickers[position.symbol],
      isHedged:
        this.memory.private[account.id].metadata.hedgedPosition[
          position.symbol
        ],
    });

    this.emitResponse({ requestId, data: [] });
  }

  async placeOrders({
    orders,
    accountId,
    requestId,
    priority = false,
  }: {
    orders: PlaceOrderOpts[];
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    const [normalOrders, conditionalOrders] = partition(
      orders,
      (order) =>
        order.type === OrderType.Market || order.type === OrderType.Limit,
    );

    if (normalOrders.length === 0) {
      this.error(`Bybit: called placeOrders without orders`);
      this.emitResponse({ requestId, data: [] });
      return [];
    }

    const formattedNormalOrders = normalOrders.flatMap((o) =>
      formatMarkerOrLimitOrder({
        order: o,
        market: this.memory.public.markets[o.symbol],
        isHedged:
          this.memory.private[accountId].metadata.hedgedPosition[o.symbol],
      }),
    );

    // Special case for bybit, we can't simply post SL/TP orders without a position open
    // We will add field on the first normalOrder to match the SL/TP configuration
    if (conditionalOrders.length > 0) {
      // We shouldn't expect more than 2 conditional orders (TP and/or SL)
      if (conditionalOrders.length > 2) {
        this.error(`Bybit: more than 2 SL/TP orders in placeOrders`);
        this.emitResponse({ requestId, data: [] });
        return [];
      }

      const sl = conditionalOrders.find(
        (o) => o.type === OrderType.StopLoss || OrderType.TrailingStopLoss,
      );

      if (sl && sl.price) {
        const slPrice = adjust(
          sl.price,
          this.memory.public.markets[sl.symbol].precision.price,
        );

        formattedNormalOrders[0].stopLoss = slPrice.toString();
        formattedNormalOrders[0].slTriggerBy = "MarkPrice";
      }

      const tp = conditionalOrders.find((o) => o.type === OrderType.TakeProfit);

      if (tp && tp.price) {
        const tpPrice = adjust(
          tp.price,
          this.memory.public.markets[tp.symbol].precision.price,
        );

        formattedNormalOrders[0].takeProfit = tpPrice.toString();
        formattedNormalOrders[0].tpTriggerBy = "LastPrice";
      }
    }

    const orderIds = await this.tradingWs[accountId].placeOrders({
      priority,
      orders: formattedNormalOrders,
    });

    this.emitResponse({ requestId, data: orderIds });

    return orderIds;
  }

  async updateOrders({
    updates,
    accountId,
    requestId,
    priority = false,
  }: {
    updates: UpdateOrderOpts[];
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    const [normalUpdates, conditionalUpdates] = partition(
      updates,
      (update) =>
        update.order.type === OrderType.Market ||
        update.order.type === OrderType.Limit,
    );

    if (normalUpdates.length > 0) {
      await this.tradingWs[accountId].updateOrders({
        priority,
        updates: normalUpdates,
      });
    }

    if (conditionalUpdates.length > 0) {
      const account = this.accounts.find((a) => a.id === accountId)!;

      for (const { order, update } of conditionalUpdates) {
        const nextOrder: PlaceOrderOpts = {
          symbol: order.symbol,
          type: order.type,
          side: order.side,
          amount: order.amount,
          reduceOnly: order.reduceOnly,
        };

        if ("price" in update) nextOrder.price = update.price;
        if ("amount" in update) nextOrder.amount = update.amount;

        await createBybitTradingStop({
          config: this.config,
          account,
          order: nextOrder,
          market: this.memory.public.markets[order.symbol],
          ticker: this.memory.public.tickers[order.symbol],
          isHedged:
            this.memory.private[accountId].metadata.hedgedPosition[
              order.symbol
            ],
        });
      }
    }

    this.emitResponse({ requestId, data: [] });
  }

  async cancelOrders({
    orderIds,
    accountId,
    requestId,
    priority = false,
  }: {
    orderIds: string[];
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    const orders = this.mapAccountOrdersFromIds({ orderIds, accountId });

    if (orders.length > 0) {
      await this.tradingWs[accountId].cancelOrders({ priority, orders });
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

    await cancelSymbolBybitOrders({
      account,
      config: this.config,
      symbol,
    });

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

    await cancelAllBybitOrders({ account, config: this.config });
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

    const positions = await fetchBybitSymbolPositions({
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

    const market = this.memory.public.markets[symbol];
    const leverageWithinBounds = Math.min(
      Math.max(leverage, market.limits.leverage.min),
      market.limits.leverage.max,
    );

    const success = await setBybitLeverage({
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
}

new BybitWorker({
  name: ExchangeName.BYBIT,
  config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.BYBIT],
  parent: self,
});
