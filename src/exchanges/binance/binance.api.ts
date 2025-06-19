import { sha256 } from "@noble/hashes/sha2";
import { hmac } from "@noble/hashes/hmac";

import { RECV_WINDOW } from "./binance.config";

import { stringify } from "~/utils";
import { request, type Request } from "~/utils/request.utils";
import { uint8ArrayToHex } from "~/utils/uint8.utils";

export const binance = async <T>(
  req: Request & { key: string; secret: string },
) => {
  const timestamp = new Date().getTime();

  const data = req.body || req.params || {};
  data.timestamp = timestamp;
  data.recvWindow = RECV_WINDOW;

  const asString = stringify(data);
  const signature = hmac(sha256, req.secret, asString);

  data.signature = uint8ArrayToHex(signature);

  req.params = data;
  delete req.body;

  const headers = {
    "X-MBX-APIKEY": req.key,
    "Content-Type": "application/json, charset=utf-8",
  };

  return request<T>({ ...req, headers });
};
