import { BaseExchange } from "../base.exchange";

import { FastTradingApi } from "~/lib/fast-trading-api.lib";
import { ExchangeName } from "~/types/lib.types";

export const createBinanceExchange = (api: FastTradingApi) => {
  return new BaseExchange({
    name: ExchangeName.BINANCE,
    config: api.config[ExchangeName.BINANCE],
    parent: api,
    createWorker() {
      return new Worker(new URL("./binance.worker", import.meta.url), {
        type: "module",
      });
    },
  });
};
