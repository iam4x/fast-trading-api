import { BaseExchange } from "../base.exchange";

import { FastTradingApi } from "~/lib/fast-trading-api.lib";
import { ExchangeName } from "~/types/lib.types";

export const createOkxExchange = (api: FastTradingApi) => {
  return new BaseExchange({
    name: ExchangeName.OKX,
    config: api.config[ExchangeName.OKX],
    parent: api,
    createWorker() {
      return new Worker(new URL("./okx.worker", import.meta.url), {
        type: "module",
      });
    },
  });
};
