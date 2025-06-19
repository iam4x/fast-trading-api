import { retry } from "./retry.utils";
import { stringify } from "./query-string.utils";

export type RequestParams = Record<
  string,
  | boolean
  | string
  | number
  | string[]
  | number[]
  | Array<Record<string, any>>
  | Record<string, any>
>;

export type Request = {
  url: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  params?: RequestParams;
  body?: RequestParams;
  retries?: number;
};

export const request = async <T>(req: Request) => {
  return retry(async () => {
    const url = req.params ? `${req.url}?${stringify(req.params)}` : req.url;
    const response = await fetch(url, {
      method: req.method ?? "GET",
      body: req.body ? JSON.stringify(req.body) : undefined,
      headers: {
        "content-type": "application/json",
        ...(req.headers || {}),
      },
    });

    return response.json() as Promise<T>;
  }, req.retries ?? 0);
};
