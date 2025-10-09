import { BaseWorker } from "../base.worker";

import {
  fetchOkxMarkets,
  fetchOkxOHLCV,
  fetchOkxTickers,
} from "./okx.resolver";
import { OkxWsPublic } from "./okx.ws-public";

import { omit } from "~/utils/omit.utils";
import { DEFAULT_CONFIG } from "~/config";
import {
  ExchangeName,
  type Account,
  type ExchangeConfig,
  type FetchOHLCVParams,
} from "~/types/lib.types";

export class OkxWorker extends BaseWorker {
  publicWs: OkxWsPublic | null = null;

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

    // for (const key in this.privateWs) {
    //   this.privateWs[key].stop();
    //   delete this.privateWs[key];
    // }
  }

  async fetchPublic() {
    // 1. Fetch markets & tickers
    const [markets, tickers] = await Promise.all([
      fetchOkxMarkets(this.config),
      fetchOkxTickers(this.config),
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

    this.log(
      `Loaded ${Object.keys(this.memory.public.markets).length} Okx markets`,
    );

    // 2. Start public websocket
    this.publicWs = new OkxWsPublic({ parent: this });
  }

  async fetchOHLCV({
    requestId,
    params,
  }: {
    requestId: string;
    params: FetchOHLCVParams;
  }) {
    const id = this.memory.public.tickers[params.symbol].id;
    const candles = await fetchOkxOHLCV({ config: this.config, params, id });
    this.emitResponse({ requestId, data: candles });
  }
}

new OkxWorker({
  name: ExchangeName.OKX,
  config: DEFAULT_CONFIG[ExchangeName.OKX],
  parent: self,
});
