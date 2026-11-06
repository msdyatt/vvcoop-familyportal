import { StripeClient } from "./stripe.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// deno-lint-ignore-file no-explicit-any

/** Test doubles for the service-role client and for Stripe's API. No network. */

export type RpcHandler = (args: Record<string, any>) => { data?: any; error?: { message: string; code?: string } | null };

export function fakeAdmin(options: { rpc?: Record<string, RpcHandler>; tables?: Record<string, any[]> } = {}) {
  const calls: { fn: string; args: Record<string, any> }[] = [];
  const updates: { table: string; values: any; filters: Record<string, any> }[] = [];
  const tables = options.tables ?? {};

  function query(table: string) {
    let rows = [...(tables[table] ?? [])];
    let pendingUpdate: any = null;
    const filters: Record<string, any> = {};
    const chain: any = {
      select: () => chain,
      update: (values: any) => { pendingUpdate = values; return chain; },
      eq: (column: string, value: any) => { filters[column] = value; rows = rows.filter((row) => row[column] === value); return chain; },
      in: (column: string, values: any[]) => { rows = rows.filter((row) => values.includes(row[column])); return chain; },
      not: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      single: () => Promise.resolve({ data: rows[0] ?? null, error: rows[0] ? null : { message: "no rows" } }),
      then: (resolve: any, reject: any) => {
        if (pendingUpdate) updates.push({ table, values: pendingUpdate, filters });
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return chain;
  }

  const client = {
    rpc: (fn: string, args: Record<string, any> = {}) => {
      calls.push({ fn, args });
      const handler = options.rpc?.[fn];
      const result = handler ? handler(args) : { data: null };
      return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
    },
    from: (table: string) => query(table),
  };
  return { client: client as never, calls, updates, called: (fn: string) => calls.filter((c) => c.fn === fn) };
}

export type StripeRoute = (params: Record<string, string>, headers: Record<string, string>) => { status?: number; body: any };

/** A StripeClient whose fetch is a lookup table keyed "GET /v1/charges/ch_1". */
export function fakeStripe(routes: Record<string, StripeRoute | any>) {
  const requests: { method: string; path: string; params: Record<string, string>; headers: Record<string, string> }[] = [];
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const raw = method === "GET" ? url.search.slice(1) : String(init?.body ?? "");
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) params[key] = value;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method, path: url.pathname, params, headers });
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return Promise.resolve(new Response(JSON.stringify({ error: { message: `No fake route for ${method} ${url.pathname}` } }), { status: 404 }));
    const result = typeof route === "function" ? route(params, headers) : { body: route };
    return Promise.resolve(new Response(JSON.stringify(result.body), { status: result.status ?? 200 }));
  };
  return { stripe: new StripeClient("sk_test_fake", fetchImpl), requests };
}
