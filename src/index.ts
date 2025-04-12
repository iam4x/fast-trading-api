import {
  type FastTradingApiOptions,
  type FetchOHLCVParams,
  type Store,
  ExchangeName,
  type Account,
  type Candle,
  type PlaceOrderOpts,
  type Timeframe,
  type Order,
} from "./types/lib.types";
import { BybitExchange } from "./exchanges/bybit/bybit.exchange";
import { MemoryStore } from "./store";

export class FastTradingApi {
  public store: Store;
  public accounts: Account[];

  private exchanges: { [ExchangeName.BYBIT]?: BybitExchange } = {};
  private listeners: { [key: string]: ((...args: any[]) => void)[] } = {};

  constructor({ accounts, store = new MemoryStore() }: FastTradingApiOptions) {
    this.accounts = accounts;
    this.store = store;

    const bybitAccounts = this.accounts.filter(
      (a) => a.exchange === ExchangeName.BYBIT,
    );

    if (bybitAccounts.length) {
      this.exchanges[ExchangeName.BYBIT] = new BybitExchange({ parent: this });
    }
  }

  public fetchOHLCV({
    exchangeName,
    params,
  }: {
    exchangeName: ExchangeName;
    params: FetchOHLCVParams;
  }): Promise<Candle[]> {
    if (!this.exchanges[exchangeName]) {
      throw new Error(`Exchange ${exchangeName} not started`);
    }

    return this.exchanges[exchangeName].fetchOHLCV(params);
  }

  public listenOHLCV({
    exchangeName,
    symbol,
    timeframe,
  }: {
    exchangeName: ExchangeName;
    symbol: string;
    timeframe: Timeframe;
  }) {
    if (!this.exchanges[exchangeName]) {
      throw new Error(`Exchange ${exchangeName} not started`);
    }

    this.exchanges[exchangeName].listenOHLCV({ symbol, timeframe });
  }

  public unlistenOHLCV({
    exchangeName,
    symbol,
    timeframe,
  }: {
    exchangeName: ExchangeName;
    symbol: string;
    timeframe: Timeframe;
  }) {
    if (!this.exchanges[exchangeName]) {
      throw new Error(`Exchange ${exchangeName} not started`);
    }

    this.exchanges[exchangeName].unlistenOHLCV({ symbol, timeframe });
  }

  public listenOrderBook({
    exchangeName,
    symbol,
  }: {
    exchangeName: ExchangeName;
    symbol: string;
  }) {
    if (!this.exchanges[exchangeName]) {
      throw new Error(`Exchange ${exchangeName} not started`);
    }

    this.exchanges[exchangeName].listenOrderBook(symbol);
  }

  public unlistenOrderBook({
    exchangeName,
    symbol,
  }: {
    exchangeName: ExchangeName;
    symbol: string;
  }) {
    if (!this.exchanges[exchangeName]) {
      throw new Error(`Exchange ${exchangeName} not started`);
    }

    this.exchanges[exchangeName].unlistenOrderBook(symbol);
  }

  public placeOrder({
    order,
    accountId,
  }: {
    order: PlaceOrderOpts;
    accountId: string;
  }) {
    return this.placeOrders({ orders: [order], accountId });
  }

  public placeOrders({
    orders,
    accountId,
  }: {
    orders: PlaceOrderOpts[];
    accountId: string;
  }) {
    const account = this.accounts.find((acc) => acc.id === accountId);
    const exchange = account?.exchange;

    if (!exchange || !this.exchanges[exchange]) {
      throw new Error(`No accounts by id found for: ${accountId}`);
    }

    return this.exchanges[exchange].placeOrders({ orders, accountId });
  }

  public updateOrder({
    order,
    update,
    accountId,
  }: {
    order: Order;
    update: { amount: number } | { price: number };
    accountId: string;
  }) {
    return this.updateOrders({ updates: [{ order, update }], accountId });
  }

  public updateOrders({
    updates,
    accountId,
  }: {
    updates: { order: Order; update: { amount: number } | { price: number } }[];
    accountId: string;
  }) {
    const account = this.accounts.find((acc) => acc.id === accountId);
    const exchange = account?.exchange;

    if (!exchange || !this.exchanges[exchange]) {
      throw new Error(`No accounts by id found for: ${accountId}`);
    }

    return this.exchanges[exchange].updateOrders({ updates, accountId });
  }

  public cancelOrder({
    orderId,
    accountId,
  }: {
    orderId: string;
    accountId: string;
  }) {
    return this.cancelOrders({ orderIds: [orderId], accountId });
  }

  public cancelOrders({
    orderIds,
    accountId,
  }: {
    orderIds: string[];
    accountId: string;
  }) {
    const account = this.accounts.find((acc) => acc.id === accountId);
    const exchange = account?.exchange;

    if (!exchange || !this.exchanges[exchange]) {
      throw new Error(`No accounts by id found for: ${accountId}`);
    }

    return this.exchanges[exchange].cancelOrders({ orderIds, accountId });
  }

  public on(
    event: "log" | "error" | "update",
    listener: (message: string) => void,
  ) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(listener);
  }

  public emit(event: "log" | "error" | "update", ...args: any[]) {
    if (!this.listeners[event]) return;
    for (const listener of this.listeners[event]) {
      listener(...args);
    }
  }
}
