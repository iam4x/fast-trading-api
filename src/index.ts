import type { FastTradingApiOptions, Store } from "./types/lib.types";
import { BybitExchange } from "./exchanges/bybit/bybit.exchange";
import { MemoryStore } from "./store";
import { ExchangeName, type ExchangeAccount } from "./types/exchange.types";

export class FastTradingApi {
  private store: Store;
  private accounts: ExchangeAccount[];
  private exchanges: { [ExchangeName.BYBIT]?: BybitExchange } = {};

  get memory() {
    return this.store.memory;
  }

  constructor({ accounts, store = new MemoryStore() }: FastTradingApiOptions) {
    this.accounts = accounts;
    this.store = store;

    const bybitAccounts = this.accounts.filter(
      (a) => a.exchange === ExchangeName.BYBIT,
    );

    if (bybitAccounts.length) {
      this.exchanges[ExchangeName.BYBIT] = new BybitExchange({
        store: this.store,
        accounts: bybitAccounts,
      });
    }
  }
}
