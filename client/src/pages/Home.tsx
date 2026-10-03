import { useAuth } from "@/_core/hooks/useAuth";
import { LanguageSwitch, ThemeToggle } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { EmailSignIn } from "@/components/EmailSignIn";
import { AnalyticsPreview } from "@/components/landing/AnalyticsPreview";
import { BrowserFrame } from "@/components/landing/BrowserFrame";
import { DemoNote } from "@/components/landing/DemoNote";
import { ExamBuilderPreview } from "@/components/landing/ExamBuilderPreview";
import { HeroDashboardPreview } from "@/components/landing/HeroDashboardPreview";
import { SharePreview } from "@/components/landing/SharePreview";
import { StudentSessionPreview } from "@/components/landing/StudentSessionPreview";
import { Button } from "@/components/ui/button";
import { safeReturnTo, startLogin } from "@/const";
import { t, type MessageKey } from "@/i18n/messages";
import { entryPath } from "@/lib/contexts";
import { trpc } from "@/lib/trpc";
import { useState } from "react";
import { Redirect, useLocation, useSearch } from "wouter";

/** Smooth-scrolls to an in-page preview, respecting reduced motion; falls back to the plain #hash jump if the target is missing. */
function scrollToId(e: React.MouseEvent<HTMLAnchorElement>, id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  e.preventDefault();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  history.pushState(null, "", `#${id}`);
}

const ctaActive = "motion-safe:transition-transform motion-safe:active:scale-[0.97]";

/** A hero/section split: copy on one side, a demo product preview in a browser frame on the other. */
function PreviewSection({
  id,
  eyebrow,
  heading,
  body,
  detail,
  reverse = false,
  children,
}: {
  id?: string;
  eyebrow?: MessageKey;
  heading: MessageKey;
  body: MessageKey;
  detail?: MessageKey;
  reverse?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`grid items-center gap-10 lg:grid-cols-2 lg:gap-16 ${reverse ? "lg:[&>*:first-child]:order-2" : ""}`}>
      <div>
        {eyebrow && <p className="text-sm font-semibold uppercase tracking-[0.2em] text-link">{t(eyebrow)}</p>}
        <h2 className="mt-2 break-words text-2xl font-semibold leading-tight sm:text-3xl">{t(heading)}</h2>
        <p className="mt-4 max-w-xl text-foreground-secondary">{t(body)}</p>
        {detail && <p className="mt-3 text-sm text-muted-foreground">{t(detail)}</p>}
      </div>
      <div>
        <BrowserFrame>{children}</BrowserFrame>
        <DemoNote className="mt-3" />
      </div>
    </section>
  );
}

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
  const [startingFree, setStartingFree] = useState(false);

  const enterDemo = async (role: "TEACHER" | "STUDENT") => {
    await demo.mutateAsync({ role });
    await utils.auth.me.invalidate();
    nav(returnTo !== "/app" ? returnTo : role === "TEACHER" ? "/teacher" : "/student");
  };

  if (!loading && user && !demo.isPending) return <Redirect to={entryPath(user, returnTo)} />;

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
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

      <main className="mx-auto max-w-6xl space-y-24 px-4 pb-24 pt-6 sm:px-6 sm:pt-10">
        {/* Hero */}
        <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
          <div className="order-1">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-link">{t("landing.hero.eyebrow")}</p>
            <h1 className="mt-3 break-words text-3xl font-semibold leading-tight sm:text-5xl">{t("landing.hero.headline")}</h1>
            <p className="mt-5 max-w-xl text-lg text-foreground-secondary">{t("landing.hero.body")}</p>
            {cancelled && <p role="status" className="mt-4 text-sm text-warning">{t("landing.cancelled")}</p>}
            {loginFailed && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {t("landing.loginFailed", { reason: loginReason })}
              </p>
            )}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                size="lg"
                disabled={startingFree}
                className={ctaActive}
                onClick={() => {
                  setStartingFree(true);
                  startLogin(returnTo);
                }}
              >
                {startingFree && <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground motion-reduce:animate-none" aria-hidden />}
                {t("landing.hero.ctaPrimary")}
              </Button>
              <Button asChild size="lg" variant="outline" className={ctaActive}>
                <a href="#dashboard-preview" onClick={(e) => scrollToId(e, "dashboard-preview")}>
                  {t("landing.hero.ctaSecondary")}
                </a>
              </Button>
            </div>
            <EmailSignIn className="max-w-sm" googleReturnTo={returnTo} />
            {demoAvailable.data && (
              <div className="mt-4 flex flex-wrap gap-3">
                <Button variant="ghost" size="sm" disabled={demo.isPending} onClick={() => void enterDemo("TEACHER")}>
                  {t("landing.demoTeacher")}
                </Button>
                <Button variant="ghost" size="sm" disabled={demo.isPending} onClick={() => void enterDemo("STUDENT")}>
                  {t("landing.demoStudent")}
                </Button>
              </div>
            )}
            {demo.error && <p role="alert" className="mt-3 text-sm text-destructive">{t("landing.demoMissing", { command: "pnpm db:seed" })}</p>}
          </div>
          <div id="dashboard-preview" className="order-2 min-w-0">
            <BrowserFrame float>
              <HeroDashboardPreview />
            </BrowserFrame>
            <DemoNote className="mt-3" />
          </div>
        </div>

        {/* 1. Exam builder */}
        <PreviewSection
          heading="landing.section.builder.title"
          body="landing.section.builder.body"
          detail="landing.section.builder.detail"
        >
          <ExamBuilderPreview />
        </PreviewSection>

        {/* 2. Student exam session */}
        <PreviewSection heading="landing.section.session.title" body="landing.section.session.body" reverse>
          <StudentSessionPreview />
        </PreviewSection>

        {/* 3. Share by link/QR */}
        <PreviewSection heading="landing.section.share.title" body="landing.section.share.body">
          <SharePreview />
        </PreviewSection>

        {/* 4. Full-width analytics */}
        <section>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-semibold leading-tight sm:text-3xl">{t("landing.section.analytics.title")}</h2>
            <p className="mt-4 text-foreground-secondary">{t("landing.section.analytics.body")}</p>
          </div>
          <div className="mt-8">
            <BrowserFrame>
              <AnalyticsPreview />
            </BrowserFrame>
            <DemoNote className="mt-3" />
          </div>
        </section>
      </main>
    </div>
  );
}
