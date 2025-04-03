import { fetchBybitOHLCV } from "./bybit.resolver";

import type { ExchangeAccount } from "~/types/exchange.types";
import type { FetchOHLCVParams, Store, StoreMemory } from "~/types/lib.types";
import type { ObjectChangeCommand, ObjectPaths } from "~/types/misc.types";

export class BybitExchange {
  private store: Store;
  private accounts: ExchangeAccount[];
  private worker: Worker;

  constructor({
    store,
    accounts,
  }: {
    store: Store;
    accounts: ExchangeAccount[];
  }) {
    this.store = store;
    this.accounts = accounts;

    this.worker = new Worker(new URL("./bybit.worker", import.meta.url), {
      type: "module",
    });

    this.worker.addEventListener("message", this.onWorkerMessage);
  }

  public fetchOHLCV(params: FetchOHLCVParams) {
    // TODO: Find a way to have this call in the worker as well
    // not sure how to do that yet, but the call should be in the web worker
    return fetchBybitOHLCV(params);
  }

  public listenOrderBook(symbol: string) {
    this.worker.postMessage({ type: "listenOrderBook", symbol });
  }

  public unlistenOrderBook(symbol: string) {
    this.worker.postMessage({ type: "unlistenOrderBook", symbol });
  }

  private onWorkerMessage = <P extends ObjectPaths<StoreMemory>>(
    event: MessageEvent<
      | { type: "ready" }
      | { type: "update"; changes: ObjectChangeCommand<StoreMemory, P>[] }
    >,
  ) => {
    if (event.data.type === "ready") return this.onReady();
    if (event.data.type === "update") {
      return this.store.applyChanges(event.data.changes);
    }
  };

  private onReady = () => {
    this.worker.postMessage({ type: "login", accounts: this.accounts });
    this.worker.postMessage({ type: "start" });
  };
}
