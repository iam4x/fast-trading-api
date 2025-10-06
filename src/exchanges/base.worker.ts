import type { ExchangeWorkerMessage } from "./base.types";

import { ChaseExtension } from "~/extenstions/chase.extension";
import { TWAPExtension } from "~/extenstions/twap.extension";
import {
  type Account,
  type StoreMemory,
  type ExchangeName,
  type Balance,
  PositionSide,
  type Position,
  type Ticker,
  type FetchOHLCVParams,
  type Timeframe,
  type PlaceOrderOpts,
  type Order,
  type Candle,
  type OrderBook,
  type ExchangeConfig,
  type UpdateOrderOpts,
  type PlacePositionStopOpts,
} from "~/types/lib.types";
import type { ObjectChangeCommand, ObjectPaths } from "~/types/misc.types";
import { mapObj } from "~/utils/map-obj.utils";
import { partition } from "~/utils/partition.utils";
import { toUSD } from "~/utils/to-usd.utils";
import { applyChanges } from "~/utils/update-obj-path.utils";

export class BaseWorker {
  parent: typeof self;
  name: ExchangeName;
  config: ExchangeConfig;

  accounts: Account[] = [];
  memory: StoreMemory[ExchangeName] = {
    loaded: { markets: false, tickers: false },
    public: { latency: 0, tickers: {}, markets: {} },
    private: {},
  };

  twapExtension = new TWAPExtension({ worker: this });
  chaseExtension = new ChaseExtension({ worker: this });

  constructor({
    parent,
    config,
    name,
  }: {
    parent: typeof self;
    config: ExchangeConfig;
    name: ExchangeName;
  }) {
    this.name = name;
    this.config = config;
    this.parent = parent;
    this.parent.addEventListener("message", this.onMessage);
    this.parent.postMessage({ type: "ready" });
  }

  onMessage = ({ data }: ExchangeWorkerMessage) => {
    if (data.type === "start") return this.start(data);
    if (data.type === "stop") return this.stop();
    if (data.type === "fetchOHLCV") return this.fetchOHLCV(data);
    if (data.type === "listenOHLCV") return this.listenOHLCV(data);
    if (data.type === "unlistenOHLCV") return this.unlistenOHLCV(data);
    if (data.type === "placePositionStop") return this.placePositionStop(data);
    if (data.type === "placeOrders") return this.placeOrders(data);
    if (data.type === "updateOrders") return this.updateOrders(data);
    if (data.type === "cancelOrders") return this.cancelOrders(data);
    if (data.type === "cancelSymbolOrders") {
      return this.cancelSymbolOrders(data);
    }
    if (data.type === "cancelAllOrders") return this.cancelAllOrders(data);
    if (data.type === "listenOB") return this.listenOrderBook(data.symbol);
    if (data.type === "unlistenOB") return this.unlistenOrderBook(data.symbol);
    if (data.type === "addAccounts") return this.addAccounts(data);
    if (data.type === "removeAccount") return this.removeAccount(data);
    if (data.type === "setLeverage") return this.setLeverage(data);
    if (data.type === "fetchPositionMetadata") {
      return this.fetchPositionMetadata(data);
    }

    // TWAP Extension
    if (data.type === "startTwap") return this.twapExtension.start(data);
    if (data.type === "pauseTwap") return this.twapExtension.pause(data);
    if (data.type === "resumeTwap") return this.twapExtension.resume(data);
    if (data.type === "stopTwap") return this.twapExtension.stop(data);

    // CHASE Extension
    if (data.type === "startChase") return this.chaseExtension.start(data);
    if (data.type === "stopChase") return this.chaseExtension.stop(data);

    // TODO: move this into an error log
    this.error(`Unsupported command to ${this.name.toUpperCase()} worker`);
  };

  stop() {
    this.error(`stop() method not implemented`);
  }

  async start({
    accounts,
    config,
  }: {
    accounts: Account[];
    requestId: string;
    config: ExchangeConfig;
  }) {
    this.log(`Initializing ${this.name.toUpperCase()} exchange data`);

    this.config = config;
    this.addAccounts({ accounts });
  }

  async addAccounts({ accounts }: { accounts: Account[]; requestId?: string }) {
    this.accounts.push(...accounts);
    this.emitChanges(
      accounts.map((acc) => ({
        type: "update",
        path: `private.${acc.id}`,
        value: {
          balance: { used: 0, free: 0, total: 0, upnl: 0 },
          positions: [],
          orders: [],
          fills: [],
          notifications: [],
          twaps: [],
          chases: [],
          metadata: {
            leverage: {},
            maxLeveragePerSymbol: {},
            hedgedPosition: {},
          },
        },
      })),
    );
  }

  async removeAccount({
    accountId,
    requestId,
  }: {
    accountId: string;
    requestId: string;
  }) {
    this.accounts = this.accounts.filter((acc) => acc.id !== accountId);

    this.emitChanges([
      { type: "removeObjectKey", path: "private", key: accountId },
    ]);

    this.parent.postMessage({ type: "response", requestId });
  }

  async fetchOHLCV(_params: { requestId: string; params: FetchOHLCVParams }) {
    this.error(`fetchOHLCV() method not implemented`);
  }

  listenOHLCV(_params: { symbol: string; timeframe: Timeframe }) {
    this.error(`listenOHLCV() method not implemented`);
  }

  unlistenOHLCV(_params: { symbol: string; timeframe: Timeframe }) {
    this.error(`unlistenOHLCV() method not implemented`);
  }

  listenOrderBook(_symbol: string) {
    this.error(`listenOrderBook() method not implemented`);
  }

  unlistenOrderBook(_symbol: string) {
    this.error(`unlistenOrderBook() method not implemented`);
  }

  updateAccountBalance({
    accountId,
    balance,
  }: {
    accountId: Account["id"];
    balance: Balance;
  }) {
    this.emitChanges([
      {
        type: "update",
        path: `private.${accountId}.balance`,
        value: balance,
      },
    ]);
  }

  removeAccountPositions({
    accountId,
    positions,
  }: {
    accountId: Account["id"];
    positions: { side: PositionSide; symbol: string }[];
  }) {
    const changes = this.memory.private[accountId].positions.reduce(
      (acc, p, idx) => {
        if (
          positions.some((p2) => p2.symbol === p.symbol && p2.side === p.side)
        ) {
          acc.push({
            type: "removeArrayElement" as const,
            path: `private.${accountId}.positions` as const,
            index: idx - acc.length,
          });
        }
        return acc;
      },
      [] as {
        type: "removeArrayElement";
        path: `private.${string}.positions`;
        index: number;
      }[],
    );

    this.emitChanges(changes);
  }

  updateAccountPositions({
    accountId,
    positions,
  }: {
    accountId: Account["id"];
    positions: Position[];
  }) {
    const [updatePositions, addPositions] = partition(positions, (position) =>
      this.memory.private[accountId].positions.some(
        (p) => p.symbol === position.symbol && p.side === position.side,
      ),
    );

    const updatePositionsChanges = updatePositions.map((position) => {
      const idx = this.memory.private[accountId].positions.findIndex(
        (p) => p.symbol === position.symbol && p.side === position.side,
      );

      return {
        type: "update" as const,
        path: `private.${accountId}.positions.${idx}` as const,
        value: position,
      };
    });

    const positionsLength = this.memory.private[accountId].positions.length;
    const addPositionsChanges = addPositions.map((position, idx) => ({
      type: "update" as const,
      path: `private.${accountId}.positions.${positionsLength + idx}` as const,
      value: position,
    }));

    const metadataChanges = positions.flatMap(
      (p) =>
        [
          {
            type: "update",
            path: `private.${accountId}.metadata.leverage.${p.symbol}`,
            value: p.leverage,
          },
          {
            type: "update",
            path: `private.${accountId}.metadata.hedgedPosition.${p.symbol}`,
            value: p.isHedged ?? false,
          },
        ] as const,
    );

    this.emitChanges([
      ...updatePositionsChanges,
      ...addPositionsChanges,
      ...metadataChanges,
    ]);
  }

  updateTicker(ticker: Ticker) {
    this.emitChanges([
      {
        type: "update",
        path: `public.tickers.${ticker.symbol}`,
        value: ticker,
      },
    ]);
  }

  updateTickerDelta(ticker: Partial<Ticker> & { symbol: string }) {
    const tickerChanges = mapObj(ticker, (key, value) => ({
      type: "update" as const,
      path: `public.tickers.${ticker.symbol}.${key}` as const,
      value,
    }));

    if (!ticker.last) {
      this.emitChanges(tickerChanges);
      return;
    }

    const positionsChanges = this.accounts.flatMap((acc) => {
      const positions = this.memory.private[acc.id].positions;
      return positions
        .filter((p) => p.symbol === ticker.symbol)
        .flatMap((p) => {
          const idx = positions.indexOf(p);
          return [
            {
              type: "update" as const,
              path: `private.${acc.id}.positions.${idx}.notional` as const,
              value: toUSD(ticker.last! * p.contracts),
            },
            {
              type: "update" as const,
              path: `private.${acc.id}.positions.${idx}.upnl` as const,
              value: toUSD(
                p.side === PositionSide.Long
                  ? p.contracts * ticker.last! - p.contracts * p.entryPrice
                  : p.contracts * p.entryPrice - p.contracts * ticker.last!,
              ),
            },
          ];
        });
    });

    this.emitChanges([...tickerChanges, ...positionsChanges]);
  }

  async placePositionStop(_params: {
    position: Position;
    stop: PlacePositionStopOpts;
    requestId: string;
    priority?: boolean;
  }) {
    this.error(`placePositionStop() method not implemented`);
  }

  async placeOrders(_params: {
    orders: PlaceOrderOpts[];
    accountId: string;
    requestId: string;
    priority?: boolean;
  }): Promise<Array<Order["id"]>> {
    this.error(`placeOrders() method not implemented`);
    return [];
  }

  async updateOrders(_params: {
    updates: UpdateOrderOpts[];
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    this.error(`updateOrders() method not implemented`);
  }

  mapAccountOrdersFromIds({
    orderIds,
    accountId,
  }: {
    orderIds: Order["id"][];
    accountId: string;
  }) {
    const orders = orderIds.reduce<Order[]>((acc, id) => {
      const order = this.memory.private[accountId].orders.find(
        (o) => o.id === id,
      );

      return order ? [...acc, order] : acc;
    }, []);

    return orders;
  }

  async cancelOrders(_params: {
    orderIds: Array<string | number>;
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    this.error(`cancelOrders() method not implemented`);
  }

  async cancelSymbolOrders(_params: {
    symbol: string;
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    this.error(`cancelSymbolOrders() method not implemented`);
  }

  async cancelAllOrders(_params: {
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    this.error(`cancelAllOrders() method not implemented`);
  }

  async fetchPositionMetadata(_params: {
    requestId: string;
    accountId: string;
    symbol: string;
  }) {
    this.error(`fetchPositionMetadata() method not implemented`);
  }

  async setLeverage(_params: {
    requestId: string;
    accountId: string;
    symbol: string;
    leverage: number;
  }) {
    this.error(`setLeverage() method not implemented`);
  }

  emitChanges = <P extends ObjectPaths<StoreMemory[ExchangeName]>>(
    changes: ObjectChangeCommand<StoreMemory[ExchangeName], P>[],
  ) => {
    // first update the memory object synchronously
    applyChanges({ obj: this.memory, changes });

    // then emit the changes to the parent main thread
    this.parent.postMessage({
      type: "update",
      changes: changes.map(({ path, ...rest }) => ({
        ...rest,
        path: `${this.name}.${path}`,
      })),
    });
  };

  log = (message: any) => {
    this.parent.postMessage({ type: "log", message });
  };

  error = (error: any) => {
    this.parent.postMessage({ type: "error", error });
  };

  emitCandle = (candle: Candle) => {
    this.parent.postMessage({ type: "candle", candle });
  };

  emitOrderBook = ({
    symbol,
    orderBook,
  }: {
    symbol: string;
    orderBook: OrderBook;
  }) => {
    this.parent.postMessage({ type: "orderBook", symbol, orderBook });
  };

  emitResponse = ({ requestId, data }: { requestId: string; data?: any }) => {
    this.parent.postMessage({ type: "response", requestId, data });
  };
}
