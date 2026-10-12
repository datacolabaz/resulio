import { Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/locale";
import { isMessageKey, t } from "@/i18n/messages";
import { errorText, fmtDateTime } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import type { Cite, TutorAction } from "@shared/coach";
import { AlertTriangle, Lock, Plus, RotateCcw, Send, Trash2 } from "lucide-react";
import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Sources } from "./LearnTab";

type Thread = RouterOutputs["student"]["coach"]["tutor"]["thread"];
type Msg = Thread["messages"][number];

const BUTTONS: Exclude<TutorAction, "ASK">[] = ["SIMPLE", "EXAMPLE", "QUIZ_ME"];
const MAX = 2000;
const BADGE_MODES = new Set(["HINT", "CHECK", "EVALUATE"]);
/** Server failures that say nothing useful to a student: shown as "couldn't show the reply, try again". */
const OPAQUE_ERRORS = new Set(["AI_INVALID_OUTPUT", "INTERNAL_ERROR"]);

const GROUNDING_CLASS: Record<string, string> = {
  MATERIAL: "bg-success-surface text-success",
  MIXED: "bg-info-surface text-info",
  GENERAL: "bg-warning-surface text-warning",
  NOT_FOUND: "bg-muted text-muted-foreground",
};

/** Whatever arrives, a message is rendered from strings and a list of well-formed sources only. */
export function safeMessage(m: Msg): Msg {
  const cites = Array.isArray(m.cites) ? m.cites.filter((c): c is Cite => !!c && typeof c === "object" && Number.isFinite(c.page) && typeof c.quote === "string") : [];
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return { ...m, content: typeof m.content === "string" ? m.content : String(m.content ?? ""), cites, mode: str(m.mode) as Msg["mode"], grounding: str(m.grounding) as Msg["grounding"], action: str(m.action) as Msg["action"] };
}

/** Keeps one broken message (or the chat) from taking the whole page down. */
export class ChatBoundary extends Component<{ children: ReactNode; onRetry?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[coach] tutor render failed", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <InlineError
        text={t("coach.tutor.renderError")}
        onRetry={() => {
          this.setState({ failed: false });
          this.props.onRetry?.();
        }}
      />
    );
  }
}

function InlineError({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{text}</span>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcw className="mr-1 h-4 w-4" aria-hidden />
          {t("coach.tutor.retry")}
        </Button>
      )}
    </div>
  );
}

/** "Soruş": the tutor, answering from this topic's material in the app language. */
export function AskTab({ topicId }: { topicId: string }) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ChatBoundary onRetry={() => setAttempt((a) => a + 1)}>
      <AskChat key={attempt} topicId={topicId} />
    </ChatBoundary>
  );
}

function AskChat({ topicId }: { topicId: string }) {
  const { locale } = useI18n();
  const utils = trpc.useUtils();
  const locked = trpc.student.coach.tutor.locked.useQuery(undefined, { refetchInterval: 60_000 });
  const threads = trpc.student.coach.tutor.threads.useQuery({ topicId });
  const [threadId, setThreadId] = useState<string | null>(null);
  const thread = trpc.student.coach.tutor.thread.useQuery({ threadId: threadId ?? "" }, { enabled: !!threadId });
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ action: TutorAction; text: string } | null>(null);
  const [failed, setFailed] = useState<{ action: TutorAction; text: string; error: string } | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const ask = trpc.student.coach.tutor.ask.useMutation({
    onSuccess: (data) => {
      utils.student.coach.tutor.thread.setData({ threadId: data.id }, data);
      setThreadId(data.id);
      setText("");
      void utils.student.coach.tutor.threads.invalidate({ topicId });
      void utils.student.coach.status.invalidate();
    },
    onError: (e, vars) => {
      const code = e instanceof Error ? e.message : "";
      setFailed({ action: vars.action, text: vars.text ?? "", error: OPAQUE_ERRORS.has(code) || !code ? t("coach.tutor.renderError") : errorText(e) });
    },
    onSettled: () => setPending(null),
  });
  const remove = trpc.student.coach.tutor.remove.useMutation({
    onSuccess: () => {
      setThreadId(null);
      void utils.student.coach.tutor.threads.invalidate({ topicId });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const raw = threadId ? thread.data?.messages : undefined;
  const messages = Array.isArray(raw) ? raw : [];
  const last = messages[messages.length - 1];
  const awaitingAnswer = last?.role === "ASSISTANT" && last.mode === "CHECK";
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [messages.length, pending, failed]);

  const submit = (action: TutorAction, body: string) => {
    if (ask.isPending || (action === "ASK" && !body)) return;
    setFailed(null);
    setPending({ action, text: body });
    ask.mutate({ topicId, threadId: threadId ?? undefined, action, text: body.slice(0, MAX), locale });
  };
  const send = (action: TutorAction) => submit(action, text.trim());

  if (locked.data?.locked) {
    return (
      <Panel>
        <p role="status" className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-surface p-3 text-sm text-warning">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t("coach.tutor.locked")}
        </p>
      </Panel>
    );
  }

  const threadList = Array.isArray(threads.data) ? threads.data : [];
  return (
    <>
      {threadList.length > 0 && (
        <Panel>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              <span className="shrink-0 text-muted-foreground">{t("coach.tutor.conversation")}</span>
              <select
                className="min-w-0 flex-1 rounded-lg border border-input bg-card px-2 py-1.5"
                value={threadId ?? ""}
                onChange={(e) => {
                  setFailed(null);
                  setThreadId(e.target.value || null);
                }}
              >
                <option value="">{t("coach.tutor.newConversation")}</option>
                {threadList.map((th) => (
                  <option key={th.id} value={th.id}>
                    {`${String(th.title ?? "").slice(0, 60)} · ${fmtDateTime(th.lastMessageAt)}`}
                  </option>
                ))}
              </select>
            </label>
            {threadId && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setFailed(null);
                    setThreadId(null);
                  }}
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden />
                  {t("coach.tutor.newConversation")}
                </Button>
                <Button size="sm" variant="ghost" disabled={remove.isPending} aria-label={t("coach.tutor.delete")} onClick={() => window.confirm(t("coach.tutor.deleteConfirm")) && remove.mutate({ threadId })}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </>
            )}
          </div>
        </Panel>
      )}
      <Panel>
        <div className="space-y-3" aria-live="polite">
          {!messages.length && !pending && !failed && <p className="text-sm text-muted-foreground">{t("coach.tutor.empty")}</p>}
          {messages.map((m, i) => (
            <ChatBoundary key={m?.id ?? i} onRetry={() => void thread.refetch()}>
              <MessageView m={m} />
            </ChatBoundary>
          ))}
          {pending && (
            <div>
              <UserBubble action={pending.action} text={pending.text} />
              <p role="status" className="mt-3 text-sm text-muted-foreground">
                {t("coach.tutor.thinking")}
              </p>
            </div>
          )}
          {failed && !pending && (
            <div className="space-y-2">
              <UserBubble action={failed.action} text={failed.text} />
              <InlineError text={failed.error} onRetry={() => submit(failed.action, failed.text)} />
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="mt-4 space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            {BUTTONS.map((b) => (
              <Button key={b} size="sm" variant="outline" disabled={ask.isPending} onClick={() => send(b)}>
                {t(`coach.tutor.action.${b}`)}
              </Button>
            ))}
          </div>
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send("ASK");
            }}
          >
            <textarea
              className="min-h-11 flex-1 resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm"
              rows={2}
              value={text}
              maxLength={MAX}
              placeholder={t(awaitingAnswer ? "coach.tutor.answerPlaceholder" : "coach.tutor.placeholder")}
              aria-label={t(awaitingAnswer ? "coach.tutor.answerPlaceholder" : "coach.tutor.placeholder")}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send("ASK");
                }
              }}
            />
            <Button type="submit" disabled={ask.isPending || !text.trim()} aria-label={t("coach.tutor.send")}>
              <Send className="h-4 w-4" aria-hidden />
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">{t("coach.tutor.note")}</p>
        </div>
      </Panel>
    </>
  );
}

function UserBubble({ action, text }: { action: string | null; text: string }) {
  const key = `coach.tutor.action.${action ?? ""}`;
  const label = action && action !== "ASK" && isMessageKey(key) ? t(key) : null;
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
        {label && <p className="text-xs opacity-80">{label}</p>}
        {text && <p className="whitespace-pre-wrap break-words">{text}</p>}
      </div>
    </div>
  );
}

const MessageView = ({ m }: { m: Msg }) => <Bubble m={safeMessage(m)} />;

function Bubble({ m }: { m: Msg }) {
  if (m.role === "USER") return <UserBubble action={m.action} text={m.content} />;
  const gKey = `coach.tutor.grounding.${m.grounding ?? "GENERAL"}`;
  const modeKey = `coach.tutor.mode.${m.mode ?? ""}`;
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm border border-border bg-card px-3 py-2 text-sm">
        <div className="flex flex-wrap gap-1">
          <span className={`rounded-full px-2 py-0.5 text-xs ${GROUNDING_CLASS[m.grounding ?? "GENERAL"] ?? GROUNDING_CLASS.GENERAL}`}>{isMessageKey(gKey) ? t(gKey) : t("coach.tutor.grounding.GENERAL")}</span>
          {m.mode && BADGE_MODES.has(m.mode) && isMessageKey(modeKey) && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t(modeKey)}</span>}
          {m.recall && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t("coach.tutor.recall")}</span>}
        </div>
        <p className="whitespace-pre-wrap break-words leading-relaxed">{m.content}</p>
        {m.cites.length > 0 && <Sources cites={m.cites} general={false} />}
      </div>
    </div>
  );
}
