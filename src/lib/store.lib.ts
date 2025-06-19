import type { ObjectPaths, ObjectChangeCommand } from "~/types/misc.types";
import type { ExchangeMemory, Store, StoreMemory } from "~/types/lib.types";
import { ExchangeName } from "~/types/lib.types";
import { applyChanges } from "~/utils/update-obj-path.utils";

export const defaultExchangeStoreState: ExchangeMemory = {
  loaded: {
    markets: false,
    tickers: false,
  },
  public: {
    latency: 0,
    tickers: {},
    markets: {},
  },
  private: {},
};

export const defaultStoreState: StoreMemory = {
  [ExchangeName.BYBIT]: structuredClone(defaultExchangeStoreState),
  [ExchangeName.HL]: structuredClone(defaultExchangeStoreState),
  [ExchangeName.BINANCE]: structuredClone(defaultExchangeStoreState),
};

export class MemoryStore implements Store {
  memory: StoreMemory = structuredClone(defaultStoreState);

  constructor() {}

  reset = () => {
    this.memory = structuredClone(defaultStoreState);
  };

  applyChanges = <P extends ObjectPaths<StoreMemory>>(
    changes: ObjectChangeCommand<StoreMemory, P>[],
  ) => {
    applyChanges({ obj: this.memory, changes });
  };
}
