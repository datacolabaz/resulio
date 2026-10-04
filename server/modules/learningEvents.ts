/**
 * After-commit learning events from the task and assessment cores. Listeners (the syllabus
 * progression hooks) run in the background and can never fail or slow down the caller.
 */

export type LearningEvent =
  | { type: "TASK_SUBMISSION_CHANGED"; submissionId: string }
  | { type: "ATTEMPT_FINISHED"; attemptId: string }
  | { type: "ASSESSMENT_RESULT_CHANGED"; resultId: string };

type Listener = (event: LearningEvent) => Promise<void> | void;
const listeners = new Set<Listener>();

export function onLearningEvent(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitLearningEvent(event: LearningEvent) {
  for (const listener of listeners) {
    setImmediate(() => {
      Promise.resolve()
        .then(() => listener(event))
        .catch((error) => console.warn("[Resulio] learning event listener failed", event.type, error));
    });
  }
}
