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

export const getBinanceNextFundingTime = () => {
  // Funding payments occur every 8 hours at 00:00 UTC, 08:00 UTC, and 16:00 UTC for all Binance Futures perpetual contracts.
  const now = Date.now();
  const nowDate = new Date(now);

  const year = nowDate.getUTCFullYear();
  const month = nowDate.getUTCMonth();
  const day = nowDate.getUTCDate();

  const startOfDayUtcMs = Date.UTC(year, month, day, 0, 0, 0, 0);
  const scheduleHours = [0, 8, 16];

  for (const hour of scheduleHours) {
    const scheduledMs = startOfDayUtcMs + hour * 60 * 60 * 1000;
    if (now <= scheduledMs) return scheduledMs;
  }

  // If all today's funding times passed, next one is tomorrow 00:00 UTC
  return startOfDayUtcMs + 24 * 60 * 60 * 1000;
};
