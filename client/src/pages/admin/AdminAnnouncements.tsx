import { useAuth } from "@/_core/hooks/useAuth";
import { ErrorNote, Loading, Panel } from "@/components/AppShell";
import { StatusBadge, type Tone } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n/messages";
import { errorText, fmtDateTime } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_LANGUAGES,
  ANNOUNCEMENT_LOCALES,
  ANNOUNCEMENT_TITLE_MAX,
  ANNOUNCEMENT_URL_MAX,
  announcementTextsValid,
  isSafeAnnouncementUrl,
  pickAnnouncementText,
  type AnnouncementAudience,
  type AnnouncementLanguage,
  type AnnouncementLocale,
  type AnnouncementText,
  type AnnouncementTexts,
} from "@shared/announcements";
import { Send } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";

const fieldLabel = "text-foreground-secondary";
const selectClass = "mt-1 h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground";
const EMPTY_TEXTS: Record<AnnouncementLocale, AnnouncementText> = {
  az: { title: "", body: "" },
  en: { title: "", body: "" },
  ru: { title: "", body: "" },
};
const STATUS_TONE: Record<string, Tone> = { QUEUED: "neutral", SENDING: "info", SENT: "success", FAILED: "danger" };

/** Locales the admin writes for: every language for AUTO (Azerbaijani required), otherwise just one. */
const localesFor = (language: AnnouncementLanguage): readonly AnnouncementLocale[] => (language === "AUTO" ? ANNOUNCEMENT_LOCALES : [language]);

function textsToSend(language: AnnouncementLanguage, texts: Record<AnnouncementLocale, AnnouncementText>): AnnouncementTexts {
  const out: AnnouncementTexts = {};
  for (const l of localesFor(language)) {
    const title = texts[l].title.trim();
    const body = texts[l].body.trim();
    if (title || body) out[l] = { title, body };
  }
  return out;
}

/**
 * Admin announcements: write once (per language), preview, send now to browser-push subscribers and,
 * for signed-in users, the in-app feed. Sending runs in the background on the server; the history
 * below refreshes until it finishes.
 */
export default function AdminAnnouncementsPage() {
  const { user } = useAuth();
  const can = (p: "announcements.view" | "announcements.send") => !!user?.admin?.permissions.includes(p);
  const utils = trpc.useUtils();
  const overview = trpc.admin.announcements.overview.useQuery(undefined, { enabled: can("announcements.view") });
  const list = trpc.admin.announcements.list.useQuery(undefined, {
    enabled: can("announcements.view"),
    refetchInterval: (query) => (query.state.data?.some((a) => a.status === "QUEUED" || a.status === "SENDING") ? 3000 : false),
  });

  if (!can("announcements.view")) return <Panel><p className="text-sm text-muted-foreground">{t("admin.noAccess")}</p></Panel>;

  return (
    <div className="space-y-5">
      <Panel title={t("admin.nav.announcements")}>
        {overview.error ? <ErrorNote error={overview.error} /> : !overview.data ? <Loading /> : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <StatusBadge tone={overview.data.webPushEnabled ? "success" : "warning"}>
              {overview.data.webPushEnabled ? t("admin.ann.pushOn") : t("admin.ann.pushOff")}
            </StatusBadge>
            <span><span className={fieldLabel}>{t("admin.ann.subscribers")}:</span> {overview.data.subscribers.total}</span>
            <span><span className={fieldLabel}>{t("admin.ann.subscribersSignedIn")}:</span> {overview.data.subscribers.signedIn}</span>
            <span><span className={fieldLabel}>{t("admin.ann.subscribersAnonymous")}:</span> {overview.data.subscribers.anonymous}</span>
          </div>
        )}
        {overview.data && !overview.data.webPushEnabled && <p className="mt-3 text-xs text-muted-foreground">{t("admin.ann.pushOffNote")}</p>}
      </Panel>

      {can("announcements.send") && (
        <Composer
          onSent={() => {
            void utils.admin.announcements.list.invalidate();
          }}
        />
      )}

      <Panel title={t("admin.ann.history")}>
        {list.error ? <ErrorNote error={list.error} /> : list.isLoading ? <Loading /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th scope="col" className="py-2 pr-3">{t("admin.ann.titleLabel")}</th>
                  <th scope="col" className="pr-3">{t("admin.ann.audience")}</th>
                  <th scope="col" className="pr-3">{t("common.status")}</th>
                  <th scope="col" className="pr-3 text-right">{t("admin.ann.inApp")}</th>
                  <th scope="col" className="pr-3 text-right">{t("admin.ann.pushSent")}</th>
                  <th scope="col" className="pr-3 text-right">{t("admin.ann.pushFailed")}</th>
                  <th scope="col">{t("admin.audit.when")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(list.data ?? []).map((row) => {
                  const text = pickAnnouncementText(row.texts ?? {}, row.language as AnnouncementLanguage, "az");
                  return (
                    <tr key={row.id}>
                      <td className="max-w-xs py-2 pr-3">
                        <span className="block truncate font-medium" title={text?.title ?? ""}>{text?.title ?? "—"}</span>
                        <span className="block text-xs text-muted-foreground">{t(`admin.ann.language.${row.language as AnnouncementLanguage}`)}</span>
                      </td>
                      <td className="pr-3 text-muted-foreground">{t(`admin.ann.audience.${row.audience}`)}</td>
                      <td className="pr-3">
                        <StatusBadge tone={STATUS_TONE[row.status] ?? "neutral"}>{t(`admin.ann.status.${row.status}`)}</StatusBadge>
                      </td>
                      <td className="pr-3 text-right tabular-nums">{row.inAppSent}</td>
                      <td className="pr-3 text-right tabular-nums">{row.pushSent}</td>
                      <td className={`pr-3 text-right tabular-nums ${row.pushFailed ? "text-destructive" : ""}`}>{row.pushFailed}</td>
                      <td className="whitespace-nowrap text-muted-foreground">{fmtDateTime(row.createdAt)}</td>
                    </tr>
                  );
                })}
                {!list.data?.length && (
                  <tr><td colSpan={7} className="py-3 text-muted-foreground">{t("admin.ann.empty")}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Composer({ onSent }: { onSent: () => void }) {
  const id = useId();
  const [audience, setAudience] = useState<AnnouncementAudience>("ALL");
  const [language, setLanguage] = useState<AnnouncementLanguage>("AUTO");
  const [texts, setTexts] = useState(EMPTY_TEXTS);
  const [url, setUrl] = useState("/");
  const [previewLocale, setPreviewLocale] = useState<AnnouncementLocale>("az");
  const [confirming, setConfirming] = useState(false);
  const send = trpc.admin.announcements.send.useMutation({
    onSuccess: () => {
      toast.success(t("admin.ann.queued"));
      setConfirming(false);
      setTexts(EMPTY_TEXTS);
      onSent();
    },
    onError: (e) => {
      setConfirming(false);
      toast.error(errorText(e));
    },
  });

  const payload = textsToSend(language, texts);
  const urlOk = isSafeAnnouncementUrl(url.trim());
  const valid = announcementTextsValid(language, payload) && urlOk;
  const locales = localesFor(language);
  const shownLocale = language === "AUTO" ? previewLocale : language;
  const preview = pickAnnouncementText(payload, language, shownLocale);

  const setText = (locale: AnnouncementLocale, field: keyof AnnouncementText, value: string) =>
    setTexts((prev) => ({ ...prev, [locale]: { ...prev[locale], [field]: value } }));

  return (
    <Panel title={t("admin.ann.new")}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) setConfirming(true);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className={fieldLabel}>{t("admin.ann.audience")}</span>
              <select className={selectClass} value={audience} onChange={(e) => setAudience(e.target.value as AnnouncementAudience)}>
                {ANNOUNCEMENT_AUDIENCES.map((a) => <option key={a} value={a}>{t(`admin.ann.audience.${a}`)}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className={fieldLabel}>{t("language.heading")}</span>
              <select className={selectClass} value={language} onChange={(e) => setLanguage(e.target.value as AnnouncementLanguage)}>
                {ANNOUNCEMENT_LANGUAGES.map((l) => <option key={l} value={l}>{t(`admin.ann.language.${l}`)}</option>)}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t(`admin.ann.audienceHint.${audience}`)}</p>
          {language === "AUTO" && <p className="text-xs text-muted-foreground">{t("admin.ann.autoHint")}</p>}

          {locales.map((locale) => (
            <fieldset key={locale} className="space-y-2 rounded-xl border border-border p-3">
              <legend className="px-1 text-xs font-medium text-foreground-secondary">
                {t(`admin.ann.language.${locale}`)}
                {language === "AUTO" && locale !== "az" ? ` · ${t("admin.ann.optional")}` : ""}
              </legend>
              <label className="block text-sm">
                <span className="flex justify-between gap-2">
                  <span className={fieldLabel}>{t("admin.ann.titleLabel")}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{texts[locale].title.length}/{ANNOUNCEMENT_TITLE_MAX}</span>
                </span>
                <Input
                  className="mt-1"
                  maxLength={ANNOUNCEMENT_TITLE_MAX}
                  value={texts[locale].title}
                  onChange={(e) => setText(locale, "title", e.target.value)}
                  onFocus={() => setPreviewLocale(locale)}
                />
              </label>
              <label className="block text-sm">
                <span className="flex justify-between gap-2">
                  <span className={fieldLabel}>{t("admin.ann.bodyLabel")}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{texts[locale].body.length}/{ANNOUNCEMENT_BODY_MAX}</span>
                </span>
                <Textarea
                  className="mt-1"
                  rows={3}
                  maxLength={ANNOUNCEMENT_BODY_MAX}
                  value={texts[locale].body}
                  onChange={(e) => setText(locale, "body", e.target.value)}
                  onFocus={() => setPreviewLocale(locale)}
                />
              </label>
            </fieldset>
          ))}

          <label className="block text-sm">
            <span className={fieldLabel}>{t("admin.ann.urlLabel")}</span>
            <Input
              className="mt-1"
              maxLength={ANNOUNCEMENT_URL_MAX}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={!urlOk}
              aria-describedby={`${id}-url-hint`}
            />
            <span id={`${id}-url-hint`} className={`mt-1 block text-xs ${urlOk ? "text-muted-foreground" : "text-destructive"}`}>
              {t("admin.ann.urlHint")}
            </span>
          </label>

          <Button type="submit" disabled={!valid || send.isPending}>
            <Send className="h-4 w-4" aria-hidden />
            {t("admin.ann.sendNow")}
          </Button>
        </form>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t("admin.ann.preview")}</h3>
            {language === "AUTO" && (
              <div className="flex gap-1" role="group" aria-label={t("admin.ann.previewLanguage")}>
                {ANNOUNCEMENT_LOCALES.map((l) => (
                  <Button key={l} type="button" size="sm" variant={previewLocale === l ? "default" : "ghost"} className="h-7 px-2" aria-pressed={previewLocale === l} onClick={() => setPreviewLocale(l)}>
                    {t(`admin.ann.languageShort.${l}`)}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-3 rounded-xl border border-border bg-background p-3 shadow-sm">
            <img src="/brand/resulio-icon.png" alt="" className="h-10 w-10 shrink-0 rounded-lg" />
            <div className="min-w-0 text-sm">
              <div className="break-words font-semibold">{preview?.title || t("admin.ann.previewTitle")}</div>
              <div className="break-words text-foreground-secondary">{preview?.body || t("admin.ann.previewBody")}</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">{previewHost(url)}</div>
            </div>
          </div>
          {language === "AUTO" && !payload[previewLocale] && preview && (
            <p className="text-xs text-muted-foreground">{t("admin.ann.previewFallback")}</p>
          )}
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={(v) => !send.isPending && setConfirming(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.ann.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("admin.ann.confirmBody", { audience: t(`admin.ann.audience.${audience}`) })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={send.isPending} onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
            <Button disabled={send.isPending} onClick={() => send.mutate({ audience, language, texts: payload, url: url.trim() })}>
              {t("admin.ann.sendNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

function previewHost(url: string): string {
  const value = url.trim();
  if (!value || value.startsWith("/")) return `resulio.co${value || "/"}`;
  try {
    return new URL(value).host + new URL(value).pathname;
  } catch {
    return value;
  }
}
