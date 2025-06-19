import { MemoryStore } from "./store.lib";

import { DEFAULT_CONFIG } from "~/config";
import type { BaseExchange } from "~/exchanges/base.exchange";
import { createBinanceExchange } from "~/exchanges/binance/binance.exchange";
import { createBybitExchange } from "~/exchanges/bybit/bybit.exchange";
import { createHyperliquidExchange } from "~/exchanges/hyperliquid/hl.exchange";
import {
  type FastTradingApiOptions,
  type FetchOHLCVParams,
  type Store,
  ExchangeName,
  type Account,
  type Position,
  type Candle,
  type PlaceOrderOpts,
  type Timeframe,
  type Order,
  type OrderBook,
  type TWAPOpts,
  type ChaseOpts,
  type ExchangeConfig,
  type PlacePositionStopOpts,
} from "~/types/lib.types";
import { deepMerge } from "~/utils/deep-merge.utils";
import { groupBy } from "~/utils/group-by.utils";
import { mapObj } from "~/utils/map-obj.utils";

export class FastTradingApi {
  store: Store;
  accounts: Account[];
  config: Record<ExchangeName, ExchangeConfig>;

  exchanges: Partial<Record<ExchangeName, BaseExchange>> = {};
  listeners: { [key: string]: ((...args: any[]) => void)[] } = {};

  constructor({ accounts, config, store }: FastTradingApiOptions) {
    this.accounts = accounts;
    this.config = deepMerge(DEFAULT_CONFIG, config);
    this.store = store ?? new MemoryStore();
  }

  async start() {
    this.emit(
      "log",
      `Starting FastTradingApi SDK with ${this.accounts.length} accounts`,
    );

    const exchangesList = new Set<ExchangeName>();
    this.accounts.forEach(({ exchange }) => exchangesList.add(exchange));

    if (exchangesList.has(ExchangeName.BYBIT)) {
      this.exchanges[ExchangeName.BYBIT] = createBybitExchange(this);
    }

    if (exchangesList.has(ExchangeName.HL)) {
      this.exchanges[ExchangeName.HL] = createHyperliquidExchange(this);
    }

    if (exchangesList.has(ExchangeName.BINANCE)) {
      this.exchanges[ExchangeName.BINANCE] = createBinanceExchange(this);
    }

    await Promise.all(
      mapObj(this.exchanges, (_name, exchange) => exchange!.start()),
    );
  }

  async stop() {
    this.emit("log", "Stopping FastTradingApi SDK");

    for (const key in this.exchanges) {
      this.exchanges[key as ExchangeName]!.stop();
      delete this.exchanges[key as ExchangeName];
    }

    this.listeners = {};
    this.store.reset();
  }

  async addAccounts(accounts: Account[]) {
    const newAccounts = accounts.filter(
      (acc) => !this.accounts.some((a) => a.id === acc.id),
    );

    if (newAccounts.length === 0) return;

    this.emit(
      "log",
      `Adding ${newAccounts.length} accounts to FastTradingApi SDK`,
    );

    this.accounts.push(...newAccounts);
    const groupedByExchange = groupBy(newAccounts, (acc) => acc.exchange);

    const promises = mapObj(
      groupedByExchange,
      async (exchangeName, exchangeAccs) => {
        if (exchangeName === ExchangeName.BYBIT) {
          if (!this.exchanges[ExchangeName.BYBIT]) {
            this.exchanges[ExchangeName.BYBIT] = createBybitExchange(this);
            await this.exchanges[ExchangeName.BYBIT].start();
          } else {
            await this.exchanges[ExchangeName.BYBIT].addAccounts(exchangeAccs);
          }
        }

        if (exchangeName === ExchangeName.HL) {
          if (!this.exchanges[ExchangeName.HL]) {
            this.exchanges[ExchangeName.HL] = createHyperliquidExchange(this);
            await this.exchanges[ExchangeName.HL].start();
          } else {
            await this.exchanges[ExchangeName.HL].addAccounts(exchangeAccs);
          }
        }

        if (exchangeName === ExchangeName.BINANCE) {
          if (!this.exchanges[ExchangeName.BINANCE]) {
            this.exchanges[ExchangeName.BINANCE] = createBinanceExchange(this);
            await this.exchanges[ExchangeName.BINANCE].start();
          } else {
            await this.exchanges[ExchangeName.BINANCE].addAccounts(
              exchangeAccs,
            );
          }
        }
      },
    );

    await Promise.all(promises);
  }

  async removeAccount(accountId: string) {
    const account = this.accounts.find((acc) => acc.id === accountId);

    if (!account) {
      this.emit("error", `Account ${accountId} not found`);
      return;
    }

    this.accounts = this.accounts.filter((acc) => acc.id !== accountId);

    if (this.accounts.some((acc) => acc.exchange === account.exchange)) {
      await this.getExchange(account.exchange).removeAccount(accountId);
    } else {
      this.getExchange(account.exchange).stop();
      delete this.exchanges[account.exchange];
    }
  }

  fetchOHLCV({
    exchangeName,
    params,
  }: {
    exchangeName: ExchangeName;
    params: FetchOHLCVParams;
  }): Promise<Candle[]> {
    return this.getExchange(exchangeName).fetchOHLCV(params);
  }

  listenOHLCV({
    exchangeName,
    symbol,
    timeframe,
    callback,
  }: {
    exchangeName: ExchangeName;
    symbol: string;
    timeframe: Timeframe;
    callback: (candle: Candle) => void;
  }) {
    this.getExchange(exchangeName).listenOHLCV({ symbol, timeframe, callback });
  }

  unlistenOHLCV({
    exchangeName,
    symbol,
    timeframe,
  }: {
    exchangeName: ExchangeName;
    symbol: string;
    timeframe: Timeframe;
  }) {
    this.getExchange(exchangeName).unlistenOHLCV({ symbol, timeframe });
  }

  listenOrderBook({
    exchangeName,
    symbol,
    callback,
  }: {
    exchangeName: ExchangeName;
    symbol: string;
    callback: (orderBook: OrderBook) => void;
  }) {
    this.getExchange(exchangeName).listenOrderBook({ symbol, callback });
  }

  unlistenOrderBook({
    exchangeName,
    symbol,
  }: {
    exchangeName: ExchangeName;
    symbol: string;
  }) {
    this.getExchange(exchangeName).unlistenOrderBook(symbol);
  }

  placePositionStop({
    position,
    stop,
    priority,
  }: {
    position: Position;
    stop: PlacePositionStopOpts;
    priority?: boolean;
  }) {
    return this.getAccountExchange(position.accountId).placePositionStop({
      position,
      stop,
      priority,
    });
  }

  placeOrder({
    order,
    accountId,
    priority = false,
  }: {
    order: PlaceOrderOpts;
    accountId: string;
    priority?: boolean;
  }) {
    return this.placeOrders({ orders: [order], accountId, priority });
  }

  placeOrders({
    orders,
    accountId,
    priority = false,
  }: {
    orders: PlaceOrderOpts[];
    accountId: string;
    priority?: boolean;
  }) {
    return this.getAccountExchange(accountId).placeOrders({
      orders,
      accountId,
      priority,
    });
  }

  updateOrder({
    order,
    update,
    priority = false,
  }: {
    order: Order;
    update: { amount: number } | { price: number };
    priority?: boolean;
  }) {
    return this.updateOrders({
      updates: [{ order, update }],
      priority,
    });
  }

  updateOrders({
    updates,
    priority = false,
  }: {
    updates: { order: Order; update: { amount: number } | { price: number } }[];
    priority?: boolean;
  }) {
    const groupedByAccount = groupBy(updates, ({ order }) => order.accountId);
    const promises = mapObj(groupedByAccount, async (accountId, updates) => {
      return this.getAccountExchange(accountId).updateOrders({
        updates,
        accountId,
        priority,
      });
    });

    return Promise.all(promises);
  }

  cancelOrder({
    orderId,
    accountId,
    priority = false,
  }: {
    orderId: string | number;
    accountId: string;
    priority?: boolean;
  }) {
    return this.cancelOrders({ orderIds: [orderId], accountId, priority });
  }

  cancelOrders({
    orderIds,
    accountId,
    priority = false,
  }: {
    orderIds: Array<string | number>;
    accountId: string;
    priority?: boolean;
  }) {
    return this.getAccountExchange(accountId).cancelOrders({
      orderIds,
      accountId,
      priority,
    });
  }

  cancelSymbolOrders({
    symbol,
    accountId,
    priority = false,
  }: {
    symbol: string;
    accountId: string;
    priority?: boolean;
  }) {
    return this.getAccountExchange(accountId).cancelSymbolOrders({
      symbol,
      accountId,
      priority,
    });
  }

  cancelAllOrders({
    accountId,
    priority = false,
  }: {
    accountId: string;
    priority?: boolean;
  }) {
    return this.getAccountExchange(accountId).cancelAllOrders({
      accountId,
      priority,
    });
  }

  fetchPositionMetadata({
    accountId,
    symbol,
  }: {
    accountId: string;
    symbol: string;
  }) {
    return this.getAccountExchange(accountId).fetchPositionMetadata({
      accountId,
      symbol,
    });
  }

  setLeverage({
    accountId,
    symbol,
    leverage,
  }: {
    accountId: string;
    symbol: string;
    leverage: number;
  }) {
    return this.getAccountExchange(accountId).setLeverage({
      accountId,
      symbol,
      leverage,
    });
  }

  startTwap({ accountId, twap }: { accountId: string; twap: TWAPOpts }) {
    return this.getAccountExchange(accountId).startTwap({
      accountId,
      twap,
    });
  }

  pauseTwap({ accountId, twapId }: { accountId: string; twapId: string }) {
    return this.getAccountExchange(accountId).pauseTwap({
      accountId,
      twapId,
    });
  }

  resumeTwap({ accountId, twapId }: { accountId: string; twapId: string }) {
    return this.getAccountExchange(accountId).resumeTwap({
      accountId,
      twapId,
    });
  }

  stopTwap({ accountId, twapId }: { accountId: string; twapId: string }) {
    return this.getAccountExchange(accountId).stopTwap({
      accountId,
      twapId,
    });
  }

  startChase({ accountId, chase }: { accountId: string; chase: ChaseOpts }) {
    return this.getAccountExchange(accountId).startChase({
      accountId,
      chase,
    });
  }

  stopChase({ accountId, chaseId }: { accountId: string; chaseId: string }) {
    return this.getAccountExchange(accountId).stopChase({
      accountId,
      chaseId,
    });
  }

  getExchange(exchangeName: ExchangeName) {
    if (!this.exchanges[exchangeName]) {
      throw new Error(`Exchange ${exchangeName} not started`);
    }

    return this.exchanges[exchangeName];
  }

  getAccountExchange(accountId: string) {
    const account = this.accounts.find((acc) => acc.id === accountId);

    if (!account) {
      throw new Error(`No accounts by id found for: ${accountId}`);
    }

    return this.getExchange(account.exchange);
  }

  on(event: "log" | "error", listener: (message: string) => void) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
  }

  emit(event: "log" | "error", ...args: any[]) {
    for (const listener of this.listeners[event] || []) {
      listener(...args);
    }
  }
}
