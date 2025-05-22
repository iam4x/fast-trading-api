import { retry } from "./retry.utils";
import { stringify } from "./query-string.utils";

export type Request = {
  url: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  params?: Record<string, string | number | string[] | number[]>;
  body?: Record<
    string,
    string | number | string[] | number[] | Array<Record<string, any>>
  >;
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
