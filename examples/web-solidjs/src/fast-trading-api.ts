import { FastTradingApi } from "fast-trading-api";
import { ExchangeName } from "fast-trading-api/dist/types/lib.types";
import { defaultStoreState } from "fast-trading-api/dist/store";
import type { Store, StoreMemory } from "fast-trading-api/dist/types/lib.types";
import type {
  ObjectPaths,
  ObjectChangeCommand,
} from "fast-trading-api/dist/types/misc.types";
import { createStore } from "solid-js/store";
import { batch } from "solid-js";

export const [store, setStore] = createStore<StoreMemory>(
  JSON.parse(JSON.stringify(defaultStoreState)),
);

class StoreConnector implements Store {
  memory: StoreMemory;

  constructor(memory: StoreMemory) {
    this.memory = memory;
  }

  reset = () => {
    setStore(JSON.parse(JSON.stringify(defaultStoreState)));
  };

  applyChanges<P extends ObjectPaths<StoreMemory>>(
    changes: ObjectChangeCommand<StoreMemory, P>[],
  ) {
    batch(() => {
      for (const change of changes) {
        const path = change.path
          .split(".")
          .map((str) => (!isNaN(Number(str)) ? Number(str) : str));

        if (change.type === "update") {
          // @ts-expect-error: Dynamic path spreading
          setStore(...[...path, change.value]);
        }

        if (change.type === "removeArrayElement") {
          setStore(
            // @ts-expect-error: Dynamic path spreading
            ...[path, (arr) => arr.filter((_, i) => i !== change.index)],
          );
        }
      }
    });
  }
}

const storeConnector = new StoreConnector(store);
const api = new FastTradingApi({
  accounts: [
    {
      id: "main",
      exchange: ExchangeName.BYBIT,
      apiKey: process.env.BYBIT_API_KEY,
      apiSecret: process.env.BYBIT_API_SECRET,
    },
  ],
  store: storeConnector,
});

api.on("log", (msg: string) => console.log(msg));
api.on("error", (msg: string) => console.error(msg));

api.start();
