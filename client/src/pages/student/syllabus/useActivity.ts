import { trpc } from "@/lib/trpc";
import { ActivityQueue, FLUSH_MS, HEARTBEAT_MS, IDLE_MS, type ActivityEvent } from "@/lib/syllabusTracker";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useRef } from "react";

/** Errors after which a batch is dropped instead of retried: the server will never accept it. */
const FINAL_CODES = new Set(["BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "UNAUTHORIZED"]);

function isFinal(error: unknown) {
  if (!(error instanceof TRPCClientError)) return false;
  const code = (error.data as { code?: string } | undefined)?.code;
  return !!code && FINAL_CODES.has(code);
}

/** Records learning activity for one syllabus; events are batched and sent at most every FLUSH_MS. */
export function useActivity(syllabusId: string | undefined) {
  const track = trpc.student.syllabus.track.useMutation();
  const send = useRef(track.mutateAsync);
  send.current = track.mutateAsync;
  const queue = useRef(new ActivityQueue());
  const sending = useRef(false);

  const flush = useCallback(async () => {
    if (!syllabusId || sending.current || !queue.current.size) return;
    const batch = queue.current.take();
    sending.current = true;
    try {
      await send.current({ id: syllabusId, events: batch });
    } catch (error) {
      if (!isFinal(error)) queue.current.restore(batch);
    } finally {
      sending.current = false;
    }
  }, [syllabusId]);

  useEffect(() => {
    if (!syllabusId) return;
    const timer = window.setInterval(() => void flush(), FLUSH_MS);
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onHide);
      void flush();
    };
  }, [syllabusId, flush]);

  return useCallback(
    (e: ActivityEvent) => {
      if (queue.current.push(e) && queue.current.full) void flush();
    },
    [flush],
  );
}

/** Active time on a lesson: a heartbeat every HEARTBEAT_MS while the tab is visible and the student is not idle. */
export function useHeartbeat(record: (e: ActivityEvent) => void, lessonId: string | undefined) {
  const lastInput = useRef(Date.now());
  useEffect(() => {
    if (!lessonId) return;
    const touch = () => {
      lastInput.current = Date.now();
    };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    for (const ev of events) window.addEventListener(ev, touch, { passive: true });
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || Date.now() - lastInput.current > IDLE_MS) return;
      record({ type: "HEARTBEAT", lessonId, durationSeconds: HEARTBEAT_MS / 1000 });
    }, HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      for (const ev of events) window.removeEventListener(ev, touch);
    };
  }, [record, lessonId]);
}
