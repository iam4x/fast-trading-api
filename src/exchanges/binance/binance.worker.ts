import { BaseWorker } from "../base.worker";

import {
  fetchBinanceAccount,
  fetchBinanceMarkets,
  fetchBinanceOHLCV,
  fetchBinanceTickers,
} from "./binance.resolver";
import { BinanceWsPublic } from "./binance.ws-public";
import { BinanceWsPrivate } from "./binance.ws-private";

import { omit } from "~/utils/omit.utils";
import {
  ExchangeName,
  type Account,
  type ExchangeConfig,
  type FetchOHLCVParams,
  type Timeframe,
} from "~/types/lib.types";
import { DEFAULT_CONFIG } from "~/config";

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

    for (const account of accounts) {
      this.privateWs[account.id] = new BinanceWsPrivate({
        parent: this,
        account,
      });
    }

    await Promise.all(
      accounts.map(async (account) => {
        await this.fetchAndPollBalancePositions(account);
        this.log(
          `Loaded Binance balance & positions for account [${account.id}]`,
        );
      }),
    );
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
      {
        type: "update",
        path: `private.${account.id}.metadata.leverage`,
        value: Object.fromEntries(
          supportedPositions.map((p) => [p.symbol, p.leverage]),
        ),
      },
      {
        type: "update",
        path: `private.${account.id}.metadata.hedgedPosition`,
        value: Object.fromEntries(
          supportedPositions.map((p) => [p.symbol, p.isHedged ?? false]),
        ),
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
}

new BinanceWorker({
  name: ExchangeName.BINANCE,
  config: DEFAULT_CONFIG[ExchangeName.BINANCE],
  parent: self,
});
