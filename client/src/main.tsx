import { API_BASE } from "@/const";
import { getActiveWorkspaceId } from "@/lib/contexts";
import { reloadForStaleChunk } from "@/lib/lazyPage";
import { trpc } from "@/lib/trpc";
import { SITE_PAGES } from "@/seo/pages";
import { UNAUTHED_ERR_MSG, WORKSPACE_HEADER } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

const PUBLIC_PATHS = [
  /^\/$/,
  /^\/login/,
  /^\/join\//,
  /^\/invite\//,
  /^\/g\//,
  /^\/exam\//,
  /^\/task\//,
  /^\/material\//,
  ...SITE_PAGES.map((page) => new RegExp(`^${page.path}$`)),
];

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;
  if (error.message !== UNAUTHED_ERR_MSG) return;
  if (PUBLIC_PATHS.some((p) => p.test(window.location.pathname))) return;
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/?returnTo=${encodeURIComponent(returnTo)}`;
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

// A chunk preloaded for a lazy page that a deploy has removed: reload once for the new build.
window.addEventListener("vite:preloadError", (event) => {
  if (reloadForStaleChunk((event as Event & { payload?: unknown }).payload)) event.preventDefault();
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_BASE}/api/trpc`,
      transformer: superjson,
      headers() {
        const ws = getActiveWorkspaceId();
        return ws ? { [WORKSPACE_HEADER]: ws } : {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
