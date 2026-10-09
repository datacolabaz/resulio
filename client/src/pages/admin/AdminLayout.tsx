import { useAuth } from "@/_core/hooks/useAuth";
import { LanguageSwitch, ThemeToggle, useDesktop } from "@/components/AppShell";
import { BrandMark } from "@/components/BrandMark";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { trpc } from "@/lib/trpc";
import type { AdminPermission } from "@shared/adminPermissions";
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  FileText,
  Folder,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Link, Redirect, useLocation } from "wouter";
import { useAdmin } from "./adminShared";

type NavChild = { href: string; label: string; permission: AdminPermission; exact?: boolean };
type NavItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Leaf items link here; parents link to their first visible child when the sidebar is icons-only. */
  href?: string;
  /** Visible when the admin holds any of these. */
  permission?: AdminPermission[];
  exact?: boolean;
  children?: NavChild[];
};
type NavSection = { id: string; heading?: string; items: NavItem[] };

const COLLAPSED_KEY = "resulio.admin.sidebarCollapsed";

function adminNav(): NavSection[] {
  return [
    {
      id: "main",
      items: [
        { id: "dashboard", href: "/admin", label: t("admin.nav.dashboard"), icon: LayoutDashboard, permission: ["overview.view"], exact: true },
        { id: "users", href: "/admin/users", label: t("admin.nav.users"), icon: Users, permission: ["users.search"] },
        {
          id: "teachers",
          label: t("admin.nav.teachers"),
          icon: GraduationCap,
          children: [{ href: "/admin/teachers/ai-limits", label: t("admin.nav.teacherQuotas"), permission: "ai.view" }],
        },
      ],
    },
    {
      id: "ai",
      heading: t("admin.nav.aiResources"),
      items: [
        {
          id: "ai-usage",
          label: t("admin.nav.aiUsage"),
          icon: Bot,
          children: [
            { href: "/admin/ai", label: t("admin.nav.aiAnalytics"), permission: "ai.view", exact: true },
            { href: "/admin/ai/logs", label: t("admin.nav.aiLogs"), permission: "ai.view" },
            { href: "/admin/ai/pricing", label: t("admin.nav.aiPricing"), permission: "ai.view" },
          ],
        },
        { id: "teacher-limits", href: "/admin/ai/limits", label: t("admin.nav.teacherLimits"), icon: SlidersHorizontal, permission: ["ai.view"] },
        { id: "storage", href: "/admin/storage", label: t("admin.nav.storage"), icon: Folder, permission: ["storage.view"] },
      ],
    },
    {
      id: "system",
      heading: t("admin.nav.system"),
      items: [
        { id: "announcements", href: "/admin/announcements", label: t("admin.nav.announcements"), icon: Megaphone, permission: ["announcements.view"] },
        { id: "audit", href: "/admin/audit", label: t("admin.nav.audit"), icon: FileText, permission: ["audit.viewSupport"] },
        { id: "security", href: "/admin/security", label: t("admin.nav.security"), icon: Shield, permission: ["security.view"] },
        { id: "settings", href: "/admin/settings", label: t("admin.nav.settings"), icon: Settings, permission: ["ai.view", "storage.view"] },
      ],
    },
  ];
}

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

const matches = (location: string, href: string, exact?: boolean) =>
  exact ? location === href : location === href || location.startsWith(`${href}/`);

/**
 * Admin console frame: a full-height dark sidebar (icons-only when collapsed on desktop, remembered per
 * browser; an off-canvas drawer below `lg`) beside a header + independently scrolling content column.
 * Items the admin lacks permission for are hidden.
 */
export function AdminLayout({ children }: { children: React.ReactNode }) {
  useI18n();
  const { user, loading } = useAuth();
  const { can } = useAdmin();
  const [location] = useLocation();
  const desktop = useDesktop();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => new Set());
  const menuButton = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const main = useRef<HTMLElement>(null);
  const drawerOpen = open && !desktop;
  const compact = collapsed && desktop;

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Private mode: the choice just isn't remembered.
    }
  }, [collapsed]);

  useEffect(() => {
    if (!drawerOpen) return;
    drawer.current?.querySelector<HTMLElement>("a[href], button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  useEffect(() => {
    setOpen(false);
    main.current?.scrollTo({ top: 0 });
  }, [location]);

  if (loading) return <div className="p-10 text-center text-muted-foreground">{t("app.loading")}</div>;
  if (!user) return <Redirect to={`/?returnTo=${encodeURIComponent(location || "/admin")}`} />;
  if (!user.isAdmin) return <Redirect to="/welcome" />;

  const allowed = (permission?: AdminPermission[]) => !permission || permission.some((p) => can(p));
  const sections = adminNav()
    .map((s) => ({
      ...s,
      items: s.items
        .map((i) => (i.children ? { ...i, children: i.children.filter((c) => can(c.permission)) } : i))
        .filter((i) => (i.children ? i.children.length > 0 : allowed(i.permission))),
    }))
    .filter((s) => s.items.length > 0);
  const toggleGroup = (id: string) =>
    setClosedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rowClass = (active: boolean) =>
    `relative flex items-center gap-3 rounded-lg text-sm transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-sidebar-ring ${
      compact ? "h-10 justify-center px-0" : "px-3 py-2"
    } ${
      active
        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-1 before:rounded-full before:bg-sidebar-primary"
        : "text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
    }`;

  const renderItem = (item: NavItem) => {
    const kids = item.children ?? [];
    const childActive = kids.some((c) => matches(location, c.href, c.exact));
    const href = item.href ?? kids[0]?.href ?? "/admin";
    const active = item.children ? childActive : matches(location, href, item.exact);
    const icon = <item.icon className={`h-[18px] w-[18px] shrink-0 ${active ? "text-sidebar-primary" : ""}`} aria-hidden />;

    if (compact || !item.children) {
      return (
        <Link
          key={item.id}
          href={href}
          aria-current={active && !item.children ? "page" : undefined}
          aria-label={compact ? item.label : undefined}
          title={compact ? item.label : undefined}
          className={rowClass(active)}
        >
          {icon}
          {!compact && <span className="min-w-0 truncate">{item.label}</span>}
        </Link>
      );
    }

    const expanded = !closedGroups.has(item.id) || childActive;
    const panelId = `admin-nav-${item.id}`;
    return (
      <div key={item.id}>
        <button type="button" onClick={() => toggleGroup(item.id)} aria-expanded={expanded} aria-controls={panelId} className={`${rowClass(false)} w-full text-left`}>
          {icon}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-sidebar-muted transition-transform motion-reduce:transition-none ${expanded ? "" : "-rotate-90"}`} aria-hidden />
        </button>
        <div id={panelId} hidden={!expanded} className="ml-[1.3rem] mt-0.5 space-y-0.5 border-l border-sidebar-border pl-3">
          {kids.map((c) => {
            const on = matches(location, c.href, c.exact);
            return (
              <Link
                key={c.href}
                href={c.href}
                aria-current={on ? "page" : undefined}
                className={`block truncate rounded-lg px-3 py-1.5 text-sm transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-sidebar-ring ${
                  on ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground"
                }`}
              >
                {c.label}
              </Link>
            );
          })}
        </div>
      </div>
    );
  };

  const closeDrawer = () => {
    setOpen(false);
    menuButton.current?.focus();
  };

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      {drawerOpen && <div className="fixed inset-0 z-40 bg-overlay" onClick={() => setOpen(false)} aria-hidden />}
      <aside
        ref={drawer}
        id="admin-sidebar"
        aria-label={t("admin.sidebar.label")}
        inert={!desktop && !open}
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[transform,width] duration-200 motion-reduce:transition-none lg:static lg:z-auto lg:translate-x-0 ${
          compact ? "lg:w-16" : "lg:w-64"
        } ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className={`flex h-16 shrink-0 items-center gap-2 border-b border-sidebar-border ${compact ? "justify-center px-2" : "px-4"}`}>
          <Link
            href="/admin"
            className="flex min-w-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring"
            aria-label={compact ? t("admin.brand") : undefined}
            title={compact ? t("admin.brand") : undefined}
          >
            <BrandMark size={32} className="shrink-0 rounded-lg" />
            {!compact && <span className="truncate text-base font-semibold text-sidebar-accent-foreground">{t("admin.brand")}</span>}
          </Link>
          <button
            type="button"
            className="ml-auto rounded-md p-1.5 hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-sidebar-ring lg:hidden"
            onClick={closeDrawer}
            aria-label={t("admin.sidebar.close")}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <nav aria-label={t("admin.sidebar.label")} className="flex-1 overflow-y-auto px-3 py-4">
          {sections.map((section, index) => (
            <div key={section.id} role="group" aria-label={section.heading} className={index > 0 ? (compact ? "mt-3 border-t border-sidebar-border pt-3" : "mt-6") : undefined}>
              {section.heading && !compact && (
                <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">{section.heading}</div>
              )}
              <div className="space-y-0.5">{section.items.map(renderItem)}</div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 space-y-3 border-t border-sidebar-border p-3">
          <div className="space-y-3 px-1 text-xs lg:hidden">
            <LanguageSwitch className="sm:hidden" tone="sidebar" />
            <Link href="/welcome" className="inline-flex items-center gap-1 text-sidebar-primary underline-offset-4 hover:underline">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {t("admin.backToApp")}
            </Link>
          </div>
          <button
            type="button"
            className={`hidden w-full items-center gap-3 rounded-lg py-2 text-sm text-sidebar-muted hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-sidebar-ring lg:flex ${
              compact ? "justify-center px-0" : "px-3"
            }`}
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? t("admin.sidebar.expand") : t("admin.sidebar.collapse")}
            title={collapsed ? t("admin.sidebar.expand") : t("admin.sidebar.collapse")}
            aria-expanded={!collapsed}
            aria-controls="admin-sidebar"
          >
            {collapsed ? <PanelLeftOpen className="h-[18px] w-[18px] shrink-0" aria-hidden /> : <PanelLeftClose className="h-[18px] w-[18px] shrink-0" aria-hidden />}
            {!compact && <span className="truncate">{t("admin.sidebar.collapse")}</span>}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="z-30 flex h-16 shrink-0 items-center gap-2 border-b bg-card px-3 sm:gap-3 sm:px-6">
          <button
            ref={menuButton}
            type="button"
            className="rounded-md p-1.5 hover:bg-muted lg:hidden"
            onClick={() => setOpen(true)}
            aria-label={t("admin.sidebar.open")}
            aria-expanded={drawerOpen}
            aria-controls="admin-sidebar"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          <AdminSearch />
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
            <LanguageSwitch className="hidden sm:flex" />
            <ThemeToggle />
            <ProfileMenu />
          </div>
        </header>
        <main ref={main} className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl p-4 sm:p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

function ProfileMenu() {
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();
  if (!user) return null;
  const initial = (user.name ?? user.email ?? "?").slice(0, 1).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:pr-2"
        aria-label={t("admin.profile.menu")}
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground" aria-hidden>
            {initial}
          </span>
        )}
        <span className="hidden max-w-[10rem] truncate text-sm font-medium md:inline">{user.name}</span>
        <ChevronDown className="hidden h-4 w-4 text-muted-foreground md:block" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-normal">
          <div className="truncate font-medium">{user.name}</div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/welcome")}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t("admin.backToApp")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void logout()}>
          <LogOut className="h-4 w-4" aria-hidden />
          {t("common.logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const SEARCH_LIMIT = 8;

/** Header search: finds users by name or e-mail and jumps to their admin page. */
function AdminSearch() {
  const { can } = useAdmin();
  const [, navigate] = useLocation();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const allowed = can("users.search");

  useEffect(() => {
    const handle = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(handle);
  }, [text]);
  useEffect(() => setHighlight(0), [query]);

  const search = trpc.admin.users.search.useQuery(
    { query, limit: SEARCH_LIMIT },
    { enabled: allowed && query.length >= 2, placeholderData: (prev) => prev, staleTime: 15_000 },
  );
  if (!allowed) return null;

  const results = query.length >= 2 ? (search.data ?? []) : [];
  const showList = open && text.trim().length > 0;
  const go = (id: number) => {
    navigate(`/admin/users/${id}`);
    setOpen(false);
    setText("");
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!results.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => (h + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + results.length) % results.length);
    } else if (e.key === "Enter" && showList) {
      e.preventDefault();
      go(results[Math.min(highlight, results.length - 1)].id);
    }
  };

  let status: string | null = null;
  if (text.trim().length < 2) status = t("admin.search.hint");
  else if (search.isFetching && !results.length) status = t("common.loading");
  else if (!results.length) status = t("admin.users.noResults");

  return (
    <div
      ref={box}
      className="relative min-w-0 flex-1 sm:max-w-md"
      onBlur={(e) => {
        if (!box.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <input
        type="search"
        role="combobox"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        aria-label={t("admin.search.label")}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && results.length ? `${listId}-${highlight}` : undefined}
        placeholder={t("admin.search.placeholder")}
        className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
      />
      {showList && (
        <ul id={listId} role="listbox" aria-label={t("admin.search.label")} className="absolute inset-x-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
          {status ? (
            <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
              {status}
            </li>
          ) : (
            results.map((u, i) => (
              <li
                key={u.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(u.id)}
                onMouseEnter={() => setHighlight(i)}
                className={`cursor-pointer rounded-md px-3 py-2 ${i === highlight ? "bg-muted" : ""}`}
              >
                <div className="truncate text-sm font-medium">{u.name ?? u.email}</div>
                <div className="truncate text-xs text-muted-foreground">{u.email}</div>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
