import { BaseWorker } from "../base.worker";

import {
  fetchHLMarketsAndTickers,
  fetchHLOHLCV,
  fetchHLUserAccount,
  fetchHLUserOrders,
  fetchHLUserOrdersHistory,
} from "./hl.resolver";
import { HyperLiquidWsPublic } from "./hl.ws-public";
import { HyperLiquidWsPrivate } from "./hl.ws-private";

import { DEFAULT_EXCHANGES_CONFIG } from "~/exchanges/exchanges.config";
import {
  ExchangeName,
  type Account,
  type ExchangeConfig,
  type FetchOHLCVParams,
  type Order,
  type PlaceOrderOpts,
  type PlacePositionStopOpts,
  type Position,
  type Timeframe,
  type UpdateOrderOpts,
} from "~/types/lib.types";

export class HyperLiquidWorker extends BaseWorker {
  publicWs: HyperLiquidWsPublic | null = null;
  privateWs: Record<Account["id"], HyperLiquidWsPrivate> = {};

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

  async fetchPublic() {
    // 1. fetch markets and tickers
    const { markets, tickers } = await fetchHLMarketsAndTickers(this.config);

    this.emitChanges([
      { type: "update", path: "loaded.markets", value: true },
      { type: "update", path: "loaded.tickers", value: true },
      { type: "update", path: "public.markets", value: markets },
      { type: "update", path: "public.tickers", value: tickers },
    ]);

    this.log(`Loaded ${Object.keys(markets).length} HyperLiquid markets`);

    // 2. start websocket connection
    this.publicWs = new HyperLiquidWsPublic({ parent: this });
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
      this.privateWs[account.id] = new HyperLiquidWsPrivate({
        parent: this,
        account,
      });
    }

    await Promise.all(
      accounts.map(async (account) => {
        const { balance, positions } = await fetchHLUserAccount({
          config: this.config,
          account,
        });

        this.emitChanges([
          {
            type: "update",
            path: `private.${account.id}.positions`,
            value: positions,
          },
          {
            type: "update",
            path: `private.${account.id}.balance`,
            value: balance,
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
          `Loaded ${positions.length} HyperLiquid positions for account [${account.id}]`,
        );
      }),
    );

    for (const account of accounts) {
      // Start listening on private data updates
      // as we have fetched the initial data from HTTP API
      this.privateWs[account.id].startListening();

      // Fetch user orders
      const orders = await fetchHLUserOrders({ config: this.config, account });

      this.log(
        `Loaded ${orders.length} HyperLiquid active orders for account [${account.id}]`,
      );

      this.emitChanges([
        {
          type: "update",
          path: `private.${account.id}.orders`,
          value: orders,
        },
      ]);

      const ordersHistory = await fetchHLUserOrdersHistory({
        config: this.config,
        account,
      });

      this.log(
        `Loaded ${ordersHistory.length} HyperLiquid orders history for account [${account.id}]`,
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

    await super.removeAccount({ accountId, requestId });
  }

  async fetchOHLCV({
    requestId,
    params,
  }: {
    requestId: string;
    params: FetchOHLCVParams;
  }) {
    const candles = await fetchHLOHLCV({ config: this.config, params });
    this.emitResponse({ requestId, data: candles });
  }

  listenOHLCV(opts: { symbol: string; timeframe: Timeframe }) {
    this.publicWs?.listenOHLCV(opts);
  }

  unlistenOHLCV(opts: { symbol: string; timeframe: Timeframe }) {
    this.publicWs?.unlistenOHLCV(opts);
  }

  listenOrderBook(symbol: string) {
    this.publicWs?.listenOrderBook(symbol);
  }

  unlistenOrderBook(symbol: string) {
    this.publicWs?.unlistenOrderBook(symbol);
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

    const position = this.memory.private[accountId].positions.find(
      (p) => p.symbol === symbol,
    );

    if (position) {
      const { leverage, isHedged } = position;
      this.emitResponse({ requestId, data: { leverage, isHedged } });
    }

    // Hyperliquid defaults are max 20x leverage
    // Otherwise max leverage per symbol
    const market = this.memory.public.markets[symbol];
    const leverage = Math.min(market.limits.leverage.max, 20);

    this.emitChanges([
      {
        type: `update`,
        path: `private.${accountId}.metadata.leverage.${symbol}`,
        value: leverage,
      },
      {
        type: `update`,
        path: `private.${accountId}.metadata.hedgedPosition.${symbol}`,
        value: false,
      },
    ]);

    this.emitResponse({ requestId, data: { leverage, isHedged: false } });
  }

  async placePositionStop({
    position,
    stop,
    requestId,
    priority = false,
  }: {
    position: Position;
    stop: PlacePositionStopOpts;
    requestId: string;
    priority?: boolean;
  }) {
    await this.privateWs[position.accountId].placePositionStop({
      position,
      stop,
      priority,
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
    const orderIds = await this.privateWs[accountId].placeOrders({
      orders,
      priority,
    });

    this.emitResponse({ requestId, data: orderIds });

    return orderIds;
  }

  async cancelOrders({
    orderIds,
    accountId,
    requestId,
    priority = false,
  }: {
    orderIds: Order["id"][];
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    const orders = this.mapAccountOrdersFromIds({ orderIds, accountId });

    if (orders.length > 0) {
      await this.privateWs[accountId].cancelOrders({ priority, orders });
    }

    this.emitResponse({ requestId, data: [] });
  }

  async cancelSymbolOrders({
    accountId,
    requestId,
    symbol,
    priority = false,
  }: {
    accountId: string;
    requestId: string;
    symbol: string;
    priority?: boolean;
  }) {
    const allOrders = this.memory.private[accountId]?.orders ?? [];
    const symbolOrders = allOrders.filter((o) => o.symbol === symbol);

    if (symbolOrders.length > 0) {
      await this.privateWs[accountId].cancelOrders({
        priority,
        orders: symbolOrders,
      });
    }

    this.emitResponse({ requestId, data: [] });
  }

  async cancelAllOrders({
    accountId,
    requestId,
    priority = false,
  }: {
    accountId: string;
    requestId: string;
    priority?: boolean;
  }) {
    const orders = this.memory.private[accountId]?.orders ?? [];

    if (orders.length > 0) {
      await this.privateWs[accountId].cancelOrders({ orders, priority });
    }

    this.emitResponse({ requestId, data: [] });
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
    await this.privateWs[accountId].updateOrders({ updates, priority });
    this.emitResponse({ requestId, data: [] });
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
      Math.max(Math.round(leverage), market.limits.leverage.min),
      market.limits.leverage.max,
    );

    const success = await this.privateWs[accountId].setLeverage({
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

new HyperLiquidWorker({
  name: ExchangeName.HL,
  config: DEFAULT_EXCHANGES_CONFIG[ExchangeName.HL],
  parent: self,
});
