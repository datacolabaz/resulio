import { useAuth } from "@/_core/hooks/useAuth";
import { LanguageSwitch, ThemeToggle } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeReturnTo } from "@/const";
import { t } from "@/i18n/messages";
import { availableContexts, CONTEXT_HOME, contextLabel, setActiveWorkspaceId } from "@/lib/contexts";
import { errorText, providerLabel, teachingCategoryLabel, teachingSubcategoryLabel } from "@/lib/format";
import { normalizeJoinInput, resolveJoinInput } from "@/lib/joinInput";
import { trpc } from "@/lib/trpc";
import { TEACHING_CATEGORIES, TEACHING_SUBCATEGORIES, type TeachingCategory } from "@shared/teachingCategories";
import { GraduationCap, LogOut, Presentation } from "lucide-react";
import { useState } from "react";
import { Link, Redirect, useLocation, useSearch } from "wouter";

export const PROVIDER_TYPES = ["TEACHER", "TRAINER", "CENTER", "SCHOOL"] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];

const FIRST_CATEGORY = TEACHING_CATEGORIES[0];
const FIRST_SUBCATEGORY = TEACHING_SUBCATEGORIES[FIRST_CATEGORY][0];

/**
 * Opens a teaching context for the signed-in user. Learning memberships are untouched.
 * The space's name isn't typed directly: it's derived from the category/subcategory the
 * teacher picks (e.g. "Riyaziyyat"), or from their own text when they pick "Digər" at either
 * level — a free-text "space name" field read as ambiguous in practice.
 */
export function WorkspaceForm({ onCreated }: { onCreated?: () => void }) {
  const [, nav] = useLocation();
  const utils = trpc.useUtils();
  const [publicDisplayName, setPublicDisplayName] = useState("");
  const [providerType, setProviderType] = useState<ProviderType>("TEACHER");
  const [category, setCategory] = useState<TeachingCategory>(FIRST_CATEGORY);
  const [subcategory, setSubcategory] = useState<string>(FIRST_SUBCATEGORY);
  const [customText, setCustomText] = useState("");

  const subcategoryOptions = category === "OTHER" ? null : TEACHING_SUBCATEGORIES[category];
  const needsCustomText = category === "OTHER" || subcategory === "OTHER";
  const title = needsCustomText ? customText.trim() : teachingSubcategoryLabel(subcategory);
  const finalSubcategory = needsCustomText ? customText.trim() : subcategory;
  const valid = title.length >= 2;

  const create = trpc.workspaces.create.useMutation({
    onSuccess: async (ws) => {
      setActiveWorkspaceId(ws.id);
      await utils.invalidate();
      onCreated?.();
      nav("/teacher");
    },
  });

  function handleCategoryChange(next: TeachingCategory) {
    setCategory(next);
    setSubcategory(next === "OTHER" ? "" : TEACHING_SUBCATEGORIES[next][0]);
    setCustomText("");
  }

  function handleSubcategoryChange(next: string) {
    setSubcategory(next);
    setCustomText("");
  }

  return (
    <form
      className="grid gap-3 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        create.mutate({ title, publicDisplayName: publicDisplayName.trim(), providerType, teachingCategory: category, teachingSubcategory: finalSubcategory });
      }}
    >
      <label className="text-sm">
        <span className="text-foreground-secondary">{t("common.required", { label: t("workspace.category") })}</span>
        <select
          className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
          value={category}
          onChange={(e) => handleCategoryChange(e.target.value as TeachingCategory)}
        >
          {TEACHING_CATEGORIES.map((k) => (
            <option key={k} value={k}>{teachingCategoryLabel(k)}</option>
          ))}
        </select>
      </label>
      {subcategoryOptions && (
        <label className="text-sm">
          <span className="text-foreground-secondary">{t("common.required", { label: t("workspace.subcategory") })}</span>
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground"
            value={subcategory}
            onChange={(e) => handleSubcategoryChange(e.target.value)}
          >
            {subcategoryOptions.map((k) => (
              <option key={k} value={k}>{teachingSubcategoryLabel(k)}</option>
            ))}
          </select>
        </label>
      )}
      {needsCustomText && (
        <label className="text-sm">
          <span className="text-foreground-secondary">{t("common.required", { label: category === "OTHER" ? t("workspace.category") : t("workspace.subcategory") })}</span>
          <Input
            required
            minLength={2}
            maxLength={120}
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder={category === "OTHER" ? t("workspace.categoryOtherPlaceholder") : t("workspace.subcategoryOtherPlaceholder")}
          />
        </label>
      )}
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
      <Button type="submit" disabled={!valid || create.isPending}>{t("workspace.create")}</Button>
      {create.error && <p role="alert" className="text-sm text-destructive">{errorText(create.error)}</p>}
    </form>
  );
}

export default function WelcomePage() {
  const { user, loading, logout } = useAuth();
  const [, nav] = useLocation();
  const search = new URLSearchParams(useSearch());
  const returnTo = safeReturnTo(search.get("returnTo"));
  const [code, setCode] = useState("");

  if (loading) return null;
  if (!user) return <Redirect to={`/?returnTo=${encodeURIComponent("/welcome")}`} />;
  if (returnTo.startsWith("/join/") || returnTo.startsWith("/g/") || returnTo.startsWith("/exam/") || returnTo.startsWith("/syllabus/")) return <Redirect to={returnTo} />;

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
          <div className="flex items-center gap-2">
            <LanguageSwitch />
            <ThemeToggle />
            <Button variant="outline" size="sm" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" aria-hidden />
              {t("common.logout")}
            </Button>
          </div>
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
                const route = resolveJoinInput(code);
                if (route) nav(route);
              }}
            >
              <label className="text-sm">
                <span className="text-foreground-secondary">{t("welcome.inviteCodeOrLink")}</span>
                <Input
                  value={code}
                  maxLength={2048}
                  onChange={(e) => setCode(normalizeJoinInput(e.target.value))}
                  placeholder={t("welcome.inviteCodeOrLinkPlaceholder")}
                />
              </label>
              <Button type="submit" variant="secondary" disabled={!resolveJoinInput(code)}>{t("welcome.joinGroup")}</Button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
