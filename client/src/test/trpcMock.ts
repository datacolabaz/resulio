import { QueryClient, useMutation, useQuery } from "@tanstack/react-query";

/**
 * A stand-in for `@/lib/trpc` in component tests: `trpc.a.b.useQuery(input)` and
 * `.useMutation(opts)` call `handlers["a.b"](input)` through a real react-query client, and
 * `trpc.useUtils()` offers `setData` / `invalidate` on the same cache.
 */
export type Handler = (input: any, path?: string) => unknown;

export function createTrpcMock() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const handlers: Record<string, Handler> = {};
  const call = async (path: string, input: unknown) => {
    const h = handlers[path] ?? handlers["*"];
    if (!h) throw new Error(`no handler for ${path}`);
    return h(input, path);
  };
  const node = (path: string[]): any =>
    new Proxy(function () {}, {
      get(_t, prop: string) {
        const key = path.join(".");
        if (prop === "useQuery")
          return (input: unknown, opts: { enabled?: boolean } = {}) =>
            useQuery({ queryKey: [key, input ?? null], queryFn: () => call(key, input), enabled: opts.enabled ?? true });
        if (prop === "useMutation") return (opts: Record<string, unknown> = {}) => useMutation({ mutationFn: (input: unknown) => call(key, input), ...opts });
        if (prop === "setData") return (input: unknown, data: unknown) => queryClient.setQueryData([key, input ?? null], data);
        if (prop === "getData") return (input: unknown) => queryClient.getQueryData([key, input ?? null]);
        if (prop === "invalidate") return async (input?: unknown) => queryClient.invalidateQueries({ queryKey: input === undefined ? [key] : [key, input] });
        if (prop === "useUtils") return () => node([]);
        return node([...path, prop]);
      },
    });
  return { trpc: node([]), queryClient, handlers };
}
