import { POSITION_SIDE } from "./binance.config";

import { ExchangeName, PositionSide } from "~/types/lib.types";
import { getKV } from "~/utils/get-kv.utils";

export const mapBinancePosition = ({
  position: p,
  accountId,
}: {
  position: Record<string, any>;
  accountId: string;
}) => {
  const entryPrice = parseFloat(getKV(p, "entryPrice"));
  const contracts = parseFloat(getKV(p, "positionAmt"));
  const upnl = parseFloat(getKV(p, "unrealizedProfit"));
  const pSide = getKV(p, "positionSide");

  const side =
    (pSide in POSITION_SIDE && POSITION_SIDE[pSide]) ||
    (contracts > 0 ? PositionSide.Long : PositionSide.Short);

  return {
    exchange: ExchangeName.BINANCE,
    accountId,
    symbol: p.symbol,
    side,
    entryPrice,
    notional: Math.abs(contracts * entryPrice + upnl),
    leverage: parseFloat(p.leverage),
    upnl,
    rpnl: 0,
    contracts: Math.abs(contracts),
    liquidationPrice: parseFloat(getKV(p, "liquidationPrice") ?? "0"),
    isHedged: pSide !== "BOTH",
  };
};
