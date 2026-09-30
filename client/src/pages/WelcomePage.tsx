import { useAuth } from "@/_core/hooks/useAuth";
import { LanguageSwitch } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeReturnTo } from "@/const";
import { t } from "@/i18n/messages";
import { availableContexts, CONTEXT_HOME, contextLabel, setActiveWorkspaceId } from "@/lib/contexts";
import { errorText, providerLabel } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { GraduationCap, Presentation } from "lucide-react";
import { useState } from "react";
import { Link, Redirect, useLocation, useSearch } from "wouter";

export const PROVIDER_TYPES = ["TEACHER", "TRAINER", "CENTER", "SCHOOL"] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Opens a teaching context for the signed-in user. Learning memberships are untouched. */
export function WorkspaceForm({ onCreated }: { onCreated?: () => void }) {
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const [title, setTitle] = useState("");
  const [publicDisplayName, setPublicDisplayName] = useState("");
  const [providerType, setProviderType] = useState<ProviderType>("TEACHER");
  const create = trpc.workspaces.create.useMutation({
    onSuccess: async (ws) => {
      setActiveWorkspaceId(ws.id);
      await utils.invalidate();
      onCreated?.();
      nav("/teacher");
    },
  });
  return (
    <form
      className="grid gap-3 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ title: title.trim(), publicDisplayName: publicDisplayName.trim(), providerType });
      }}
    >
      <label className="text-sm">
        <span className="text-foreground-secondary">{t("common.required", { label: t("workspace.title") })}</span>
        <Input required minLength={2} maxLength={255} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("workspace.titlePlaceholder")} />
      </label>
      <label className="text-sm">
        <span className="text-foreground-secondary">{t("workspace.displayName")}</span>
        <Input maxLength={255} value={publicDisplayName} onChange={(e) => setPublicDisplayName(e.target.value)} placeholder={t("workspace.displayNamePlaceholder")} />
      </label>
      <label className="text-sm">
        <span className="text-foreground-secondary">{t("common.type")}</span>
        <select
          className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
          value={providerType}
          onChange={(e) => setProviderType(e.target.value as ProviderType)}
        >
          {PROVIDER_TYPES.map((k) => (
            <option key={k} value={k}>{providerLabel(k)}</option>
          ))}
        </select>
      </label>
      <Button type="submit" disabled={title.trim().length < 2 || create.isPending}>{t("workspace.create")}</Button>
      {create.error && <p role="alert" className="text-sm text-destructive">{errorText(create.error)}</p>}
    </form>
  );
}

export default function WelcomePage() {
  const { user, loading } = useAuth();
  const [, nav] = useLocation();
  const search = new URLSearchParams(useSearch());
  const returnTo = safeReturnTo(search.get("returnTo"));
  const [code, setCode] = useState("");

  if (loading) return null;
  if (!user) return <Redirect to={`/?returnTo=${encodeURIComponent("/welcome")}`} />;
  if (returnTo.startsWith("/join/") || returnTo.startsWith("/exam/")) return <Redirect to={returnTo} />;

  const contexts = availableContexts(user);
  const onlyPending = user.pendingMemberships > 0 && user.activeMemberships === 0 && !user.contexts.teaching;

  return (
    <main className="min-h-screen bg-background p-4 text-foreground sm:p-6">
      <div className="mx-auto max-w-4xl py-6 sm:py-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark size={48} className="shrink-0 rounded-xl" />
            <div className="min-w-0">
              <h1 className="break-words text-2xl font-semibold">{user.name ? t("welcome.greetingName", { name: user.name }) : t("welcome.greeting")}</h1>
              <p className="text-sm text-muted-foreground">{t("welcome.lead")}</p>
            </div>
          </div>
          <LanguageSwitch />
        </div>

        {onlyPending && (
          <div className="mt-6 rounded-2xl border bg-card p-5 text-sm">
            <p className="font-medium">{t("welcome.pending")}</p>
            <Link href="/student/groups" className="mt-2 inline-block font-medium text-link underline underline-offset-4">{t("public.myGroups")}</Link>
          </div>
        )}

        {contexts.length > 0 && (
          <nav aria-labelledby="welcome-spaces" className="mt-6 rounded-2xl border bg-card p-5">
            <h2 id="welcome-spaces" className="text-sm font-semibold">{t("welcome.spaces")}</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {contexts.map((c) => (
                <Button key={c} asChild variant="outline">
                  <Link href={CONTEXT_HOME[c]}>{contextLabel(c)}</Link>
                </Button>
              ))}
            </div>
          </nav>
        )}

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <section aria-labelledby="welcome-teach" className="rounded-2xl border bg-card p-6">
            <Presentation className="h-6 w-6" aria-hidden />
            <h2 id="welcome-teach" className="mt-3 text-lg font-semibold">{t("welcome.teach.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("welcome.teach.body")}</p>
            <div className="mt-5">
              <WorkspaceForm />
            </div>
          </section>

          <section aria-labelledby="welcome-learn" className="rounded-2xl border bg-card p-6">
            <GraduationCap className="h-6 w-6" aria-hidden />
            <h2 id="welcome-learn" className="mt-3 text-lg font-semibold">{t("welcome.learn.title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("welcome.learn.body")}</p>
            <form
              className="mt-5 grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim().length >= 4) nav(`/join/${encodeURIComponent(code.trim().toUpperCase())}`);
              }}
            >
              <label className="text-sm">
                <span className="text-foreground-secondary">{t("welcome.inviteCode")}</span>
                <Input value={code} maxLength={32} onChange={(e) => setCode(e.target.value)} placeholder={t("welcome.inviteCodePlaceholder")} />
              </label>
              <Button type="submit" variant="secondary" disabled={code.trim().length < 4}>{t("welcome.joinGroup")}</Button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
