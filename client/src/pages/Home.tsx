import { useAuth } from "@/_core/hooks/useAuth";
import { LanguageSwitch, ThemeToggle } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { safeReturnTo, startLogin } from "@/const";
import { t, type MessageKey } from "@/i18n/messages";
import { entryPath } from "@/lib/contexts";
import { trpc } from "@/lib/trpc";
import { Redirect, useLocation, useSearch } from "wouter";

const FEATURES: { title: MessageKey; body: MessageKey }[] = [
  { title: "landing.feature.builder.title", body: "landing.feature.builder.body" },
  { title: "landing.feature.session.title", body: "landing.feature.session.body" },
  { title: "landing.feature.analytics.title", body: "landing.feature.analytics.body" },
  { title: "landing.feature.sharing.title", body: "landing.feature.sharing.body" },
];

export default function Home() {
  const { user, loading } = useAuth();
  const search = useSearch();
  const loginParams = new URLSearchParams(search);
  const returnTo = safeReturnTo(loginParams.get("returnTo"));
  const cancelled = loginParams.get("login") === "cancelled";
  const loginFailed = loginParams.get("login") === "failed";
  const loginReason = loginParams.get("reason") || "unknown";
  const demoAvailable = trpc.auth.demoAvailable.useQuery();
  const demo = trpc.auth.demoLogin.useMutation();
  const [, nav] = useLocation();
  const utils = trpc.useUtils();

  const enterDemo = async (role: "TEACHER" | "STUDENT") => {
    await demo.mutateAsync({ role });
    await utils.auth.me.invalidate();
    nav(returnTo !== "/app" ? returnTo : role === "TEACHER" ? "/teacher" : "/student");
  };

  if (!loading && user && !demo.isPending) return <Redirect to={entryPath(user, returnTo)} />;

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="absolute inset-x-0 top-0 h-1 bg-brand" aria-hidden />
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 sm:px-6">
        <div className="flex items-center gap-3">
          <BrandMark size={44} className="rounded-xl" />
          <div>
            <div className="text-xl font-semibold tracking-tight">Resulio</div>
            <div className="text-xs text-link">{t("brand.tagline")}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitch />
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-12 px-4 py-10 sm:px-6 sm:py-16 lg:grid-cols-2 lg:items-center">
        <div>
          <p className="text-sm uppercase tracking-[0.25em] text-link">AZ · RU · EN</p>
          <h1 className="mt-4 break-words text-3xl font-semibold leading-tight sm:text-5xl">{t("landing.headline")}</h1>
          <p className="mt-5 max-w-xl text-lg text-foreground-secondary">{t("landing.lead")}</p>
          {cancelled && <p role="status" className="mt-4 text-sm text-warning">{t("landing.cancelled")}</p>}
          {loginFailed && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {t("landing.loginFailed", { reason: loginReason })}
            </p>
          )}
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button size="lg" onClick={() => startLogin(returnTo)}>{t("common.signInGoogle")}</Button>
            {demoAvailable.data && (
              <>
                <Button size="lg" variant="secondary" disabled={demo.isPending} onClick={() => void enterDemo("TEACHER")}>
                  {t("landing.demoTeacher")}
                </Button>
                <Button size="lg" variant="outline" disabled={demo.isPending} onClick={() => void enterDemo("STUDENT")}>
                  {t("landing.demoStudent")}
                </Button>
              </>
            )}
          </div>
          {demo.error && <p role="alert" className="mt-3 text-sm text-destructive">{t("landing.demoMissing", { command: "pnpm db:seed" })}</p>}
        </div>
        <div className="rounded-3xl border border-border bg-card p-6 shadow-card">
          <ul className="space-y-4 text-sm text-foreground-secondary">
            {FEATURES.map((f) => (
              <li key={f.title}>
                <span className="font-semibold text-foreground">{t(f.title)}</span> — {t(f.body)}
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
