import { useAuth } from "@/_core/hooks/useAuth";
import { Wordmark } from "@/components/BrandMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { themeLabel, useTheme, type ThemePreference } from "@/contexts/ThemeContext";
import { useI18n } from "@/i18n/locale";
import { LOCALE_NAMES, supportedLocales, t, type MessageKey } from "@/i18n/messages";
import { availableContexts, CONTEXT_HOME, contextLabel, getActiveWorkspaceId, setActiveWorkspaceId, type UiContext } from "@/lib/contexts";
import { errorText, fmtDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import {
  Bell,
  Check,
  ClipboardList,
  FileText,
  FolderOpen,
  Gauge,
  GraduationCap,
  Handshake,
  LayoutDashboard,
  LineChart,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Presentation,
  Settings,
  Shield,
  Sun,
  TrendingUp,
  Trophy,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";

const CONTEXT_ICON: Record<UiContext, typeof LayoutDashboard> = {
  learning: GraduationCap,
  teaching: Presentation,
  partner: Handshake,
};

export const THEME_OPTIONS: { value: ThemePreference; icon: typeof Sun }[] = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

type NavItem = { href: string; label: string; icon: typeof LayoutDashboard; exact?: boolean };

const TEACHER_NAV: { href: string; key: MessageKey; icon: typeof LayoutDashboard; exact?: boolean }[] = [
  { href: "/teacher", key: "nav.home", icon: LayoutDashboard, exact: true },
  { href: "/teacher/assessments", key: "nav.exams", icon: ClipboardList },
  { href: "/teacher/groups", key: "nav.groups", icon: Users },
  { href: "/teacher/assignments", key: "nav.assignments", icon: FileText },
  { href: "/teacher/library", key: "nav.materials", icon: FolderOpen },
  { href: "/teacher/results", key: "nav.results", icon: ListChecks },
  { href: "/teacher/analytics", key: "nav.analytics", icon: LineChart },
  { href: "/teacher/usage", key: "nav.usage", icon: Gauge },
  { href: "/partner", key: "nav.referral", icon: Handshake },
  { href: "/settings", key: "nav.settings", icon: Settings },
];

const STUDENT_NAV: typeof TEACHER_NAV = [
  { href: "/student", key: "nav.home", icon: LayoutDashboard, exact: true },
  { href: "/student/assessments", key: "nav.exams", icon: ClipboardList },
  { href: "/student/assignments", key: "nav.assignments", icon: FileText },
  { href: "/student/materials", key: "nav.materials", icon: FolderOpen },
  { href: "/student/groups", key: "nav.myGroups", icon: Users },
  { href: "/student/results", key: "nav.myResults", icon: ListChecks },
  { href: "/student/progress", key: "nav.myProgress", icon: TrendingUp },
  { href: "/student/profile", key: "nav.myProfile", icon: Trophy },
  { href: "/partner", key: "nav.referral", icon: Handshake },
  { href: "/settings", key: "nav.settings", icon: Settings },
];

const DESKTOP_QUERY = "(min-width: 1024px)";

/** The sidebar is a static column from `lg`; below that it is an off-canvas drawer. */
function useDesktop() {
  const [desktop, setDesktop] = useState(() => window.matchMedia?.(DESKTOP_QUERY).matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.(DESKTOP_QUERY);
    if (!media) return;
    const onChange = () => setDesktop(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

export function LanguageSwitch({ className = "" }: { className?: string }) {
  const { locale, setLocale } = useI18n();
  return (
    <div role="group" aria-label={t("language.heading")} className={`flex items-center gap-1 ${className}`}>
      {supportedLocales.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          onClick={() => setLocale(code)}
          aria-pressed={locale === code}
          aria-label={LOCALE_NAMES[code]}
          className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase ${locale === code ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
        >
          {code}
        </button>
      ))}
    </div>
  );
}

/**
 * Compact light/dark toggle for headers outside the signed-in app shell (the landing page,
 * the welcome screen) — those only had a language switch, with no visible way to change the
 * theme short of signing in and opening the account menu. A single icon button, showing the
 * currently-active mode, is enough here; the full light/dark/system choice still lives in the
 * account menu and Settings for anyone who wants "follow system" specifically.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, setPreference } = useTheme();
  const next: ThemePreference = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setPreference(next)}
      aria-label={themeLabel(next)}
      title={themeLabel(next)}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-input bg-card text-foreground transition-colors hover:bg-muted ${className}`}
    >
      {theme === "dark" ? <Moon className="h-4 w-4" aria-hidden /> : <Sun className="h-4 w-4" aria-hidden />}
    </button>
  );
}

export function AppShell({
  area,
  children,
  title: titleOverride,
}: {
  /** Active UI context; undefined for context-neutral pages such as settings. */
  area?: UiContext;
  children: React.ReactNode;
  title?: string;
}) {
  useI18n();
  const { user, logout } = useAuth();
  const { preference, setPreference } = useTheme();
  const [location, nav] = useLocation();
  const desktop = useDesktop();
  const [open, setOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const utils = trpc.useUtils();
  const notes = trpc.inbox.list.useQuery(undefined, { refetchInterval: 60_000 });
  const markRead = trpc.inbox.read.useMutation({ onSuccess: () => utils.inbox.list.invalidate() });
  const unread = notes.data?.filter((n) => !n.read).length ?? 0;
  const drawerOpen = open && !desktop;

  useEffect(() => {
    if (!drawerOpen && !inboxOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (drawerOpen) {
        setOpen(false);
        menuButton.current?.focus();
      }
      setInboxOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, inboxOpen]);

  useEffect(() => {
    if (drawerOpen) drawer.current?.querySelector<HTMLElement>("a[href], button")?.focus();
  }, [drawerOpen]);

  const toItems = (list: typeof TEACHER_NAV): NavItem[] => list.map((i) => ({ href: i.href, label: t(i.key), icon: i.icon, exact: i.exact }));
  const partnerNav: NavItem[] = [
    { href: "/partner", label: contextLabel("partner"), icon: Handshake, exact: true },
    { href: "/settings", label: t("nav.settings"), icon: Settings },
  ];
  const neutralNav: NavItem[] = [
    ...(user ? availableContexts(user) : []).map((c) => ({ href: CONTEXT_HOME[c], label: contextLabel(c), icon: CONTEXT_ICON[c], exact: true })),
    { href: "/settings", label: t("nav.settings"), icon: Settings },
  ];
  const items = area === "teaching" ? toItems(TEACHER_NAV) : area === "learning" ? toItems(STUDENT_NAV) : area === "partner" ? partnerNav : neutralNav;
  const activeWorkspace = user?.workspaces.find((w) => w.id === getActiveWorkspaceId()) ?? user?.workspaces[0];
  const isActive = (i: NavItem) => (i.exact ? location === i.href : location === i.href || location.startsWith(`${i.href}/`));
  const title = titleOverride ?? items.find(isActive)?.label ?? "Resulio";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        {drawerOpen && <div className="fixed inset-0 z-30 bg-overlay" onClick={() => setOpen(false)} aria-hidden />}
        <aside
          ref={drawer}
          id="app-sidebar"
          inert={!desktop && !open}
          className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-sidebar text-sidebar-foreground transition-transform motion-reduce:transition-none lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:border-r lg:border-sidebar-border ${open ? "translate-x-0" : "-translate-x-full"}`}
        >
          <div className="h-1 bg-sidebar-primary" />
          <div className="flex items-center justify-between px-5 py-5">
            <Link href={area ? CONTEXT_HOME[area] : "/app"} className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring">
              <Wordmark />
            </Link>
            <button
              type="button"
              className="rounded-md p-1 focus-visible:outline-2 focus-visible:outline-sidebar-ring lg:hidden"
              onClick={() => {
                setOpen(false);
                menuButton.current?.focus();
              }}
              aria-label={t("shell.closeMenu")}
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          {area === "teaching" && (
            <div className="px-4 pb-4">
              <Link
                href="/teacher/assessments/new"
                onClick={() => setOpen(false)}
                className="flex w-full items-center justify-center rounded-xl bg-sidebar-primary px-4 py-2.5 text-sm font-semibold text-sidebar-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
              >
                + {t("nav.newExam")}
              </Link>
            </div>
          )}
          <nav aria-label={t("shell.primaryNav")} className="flex-1 space-y-1 overflow-y-auto px-3 pb-6">
            {items.map((item) => {
              const active = isActive(item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm focus-visible:outline-2 focus-visible:outline-sidebar-ring ${active ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-sidebar-primary" : "text-sidebar-foreground hover:bg-sidebar-accent/60"}`}
                >
                  <item.icon className={`h-4 w-4 shrink-0 ${active ? "text-sidebar-primary" : ""}`} aria-hidden />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-sidebar-border px-5 py-4 text-xs text-sidebar-muted">
            <div className="truncate font-medium text-sidebar-accent-foreground" title={user?.name ?? undefined}>{user?.name}</div>
            <div className="truncate" title={user?.email ?? undefined}>{user?.email}</div>
            {area && <div className="mt-1 uppercase tracking-wide text-sidebar-primary">{contextLabel(area)}</div>}
            {area === "teaching" && activeWorkspace && <div className="truncate text-sidebar-foreground" title={activeWorkspace.title}>{activeWorkspace.title}</div>}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-2 border-b bg-card/95 px-4 backdrop-blur">
            <div className="flex min-w-0 items-center gap-3">
              <button
                ref={menuButton}
                type="button"
                className="rounded-md p-1 lg:hidden"
                onClick={() => setOpen(true)}
                aria-label={t("shell.openMenu")}
                aria-expanded={drawerOpen}
                aria-controls="app-sidebar"
              >
                <Menu className="h-5 w-5" aria-hidden />
              </button>
              <h1 className="truncate text-lg font-semibold tracking-tight" title={title}>{title}</h1>
            </div>
            <div className="flex shrink-0 items-center gap-1 sm:gap-2">
              <LanguageSwitch className="hidden sm:flex" />
              <ThemeToggle />
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setInboxOpen((v) => !v)}
                  className="relative rounded-full p-2 hover:bg-muted"
                  aria-expanded={inboxOpen}
                  aria-label={unread > 0 ? t("shell.notificationsUnread", { count: unread }) : t("shell.notifications")}
                >
                  <Bell className="h-5 w-5" aria-hidden />
                  {unread > 0 && (
                    <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground" aria-hidden>
                      {unread}
                    </span>
                  )}
                </button>
                {inboxOpen && (
                  <div role="region" aria-label={t("shell.notifications")} className="absolute right-0 top-11 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border bg-popover p-2 text-popover-foreground shadow-overlay">
                    <div className="px-2 py-1 text-sm font-semibold">{t("shell.notifications")}</div>
                    <div className="max-h-80 overflow-y-auto">
                      {(notes.data ?? []).length === 0 && <div className="p-4 text-center text-sm text-muted-foreground">{t("shell.noNotifications")}</div>}
                      {(notes.data ?? []).map((n) => (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => !n.read && markRead.mutate({ id: n.id })}
                          className={`block w-full rounded-xl px-3 py-2 text-left text-sm hover:bg-muted ${n.read ? "text-muted-foreground" : ""}`}
                        >
                          <div className="font-medium">{n.title}</div>
                          <div className="text-xs">{n.body}</div>
                          <div className="text-xs text-muted-foreground">{fmtDateTime(n.createdAt)}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger className="rounded-full p-1 hover:bg-muted" aria-label={t("shell.accountMenu")}>
                  {user?.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground" aria-hidden>
                      {(user?.name ?? "?").slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel className="font-normal">
                    <div className="truncate font-medium">{user?.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{user?.email}</div>
                  </DropdownMenuLabel>
                  {user && availableContexts(user).length > 0 && (
                    <>
                      <DropdownMenuSeparator />
                      {availableContexts(user).map((c) => {
                        const Icon = CONTEXT_ICON[c];
                        return (
                          <DropdownMenuItem key={c} onSelect={() => nav(CONTEXT_HOME[c])} aria-current={area === c ? "true" : undefined}>
                            <Icon className="h-4 w-4" aria-hidden />
                            <span className={area === c ? "font-semibold" : ""}>{contextLabel(c)}</span>
                            {area === c && <Check className="ml-auto h-4 w-4" aria-label={t("common.active")} />}
                          </DropdownMenuItem>
                        );
                      })}
                    </>
                  )}
                  {area === "teaching" && user && user.workspaces.length > 1 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel className="text-xs text-muted-foreground">{t("shell.workspace")}</DropdownMenuLabel>
                      {user.workspaces.map((w) => (
                        <DropdownMenuItem
                          key={w.id}
                          onSelect={() => {
                            setActiveWorkspaceId(w.id);
                            void utils.invalidate();
                            nav("/teacher");
                          }}
                        >
                          <span className={`truncate ${w.id === activeWorkspace?.id ? "font-semibold" : ""}`}>{w.title}</span>
                          {w.id === activeWorkspace?.id && <Check className="ml-auto h-4 w-4" aria-label={t("common.active")} />}
                        </DropdownMenuItem>
                      ))}
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => nav("/welcome")}>
                    <Plus className="h-4 w-4" aria-hidden />
                    {t("shell.newWorkspace")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs text-muted-foreground">{t("theme.heading")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
                    {THEME_OPTIONS.map(({ value, icon: Icon }) => (
                      <DropdownMenuRadioItem key={value} value={value} onSelect={(e) => e.preventDefault()}>
                        <Icon className="h-4 w-4" aria-hidden />
                        {themeLabel(value)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => nav("/settings")}>
                    <Settings className="h-4 w-4" aria-hidden />
                    {t("nav.settings")}
                  </DropdownMenuItem>
                  {user?.isAdmin && (
                    <DropdownMenuItem onSelect={() => nav("/admin/users")}>
                      <Shield className="h-4 w-4" aria-hidden />
                      {t("nav.admin")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => void logout()}>
                    <LogOut className="h-4 w-4" aria-hidden />
                    {t("common.logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main id="main" className="flex-1 p-4 md:p-8">{children}</main>
        </div>
      </div>
    </div>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-card p-5">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 break-words font-[family-name:var(--font-display)] text-3xl">{value}</div>
      {hint && <div className="mt-1 text-sm text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center">
      <div className="text-lg font-semibold">{title}</div>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Panel({ title, action, children, className = "" }: { title?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-2xl border border-border bg-card p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          {title && <h2 className="font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** Neutral metadata tag (type, version, counts). Use StatusBadge for statuses. */
export function Pill({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full border border-border bg-neutral-surface px-2.5 py-0.5 text-xs font-medium text-neutral ${className}`}>{children}</span>;
}

/** Toggle/filter chip. Selected state = inverted fill + check icon + aria-pressed, not colour alone. */
export function ChoiceChip({
  selected,
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground ${selected ? "border-primary bg-primary font-medium text-primary-foreground" : "border-input bg-card text-foreground hover:bg-muted"} ${className}`}
      {...props}
    >
      {selected && <Check className="h-3.5 w-3.5" aria-hidden />}
      {children}
    </button>
  );
}

export function Loading() {
  return (
    <div role="status" className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-link motion-reduce:animate-none" aria-hidden />
      {t("common.loading")}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-xl border border-destructive/40 bg-danger-surface p-3 text-sm text-destructive">
      {errorText(error)}
    </div>
  );
}
