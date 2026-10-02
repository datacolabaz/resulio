/**
 * Static, fictional numbers behind every product preview on the landing page (hero + the four
 * sections below it). No real teacher, student, group or exam — see landing.preview.* in
 * client/src/i18n/catalog/app.ts for the text shown with these numbers, and DemoNote for the
 * "example interface" disclosure rendered under every preview.
 */
export const DEMO = {
  studentCount: 26,
  completedCount: 24,
  activeGroups: 3,
  activeExams: 2,
  completedThisWeek: 4,
  medianScore: 72,
  weakTopicAccuracy: 42,
  mostMissedQuestionNumber: 7,
  /** Sums to `completedCount` (24). Shape only — DistributionChart draws the real analytic read. */
  scoreDistribution: [
    { from: 40, to: 50, count: 1 },
    { from: 50, to: 60, count: 3 },
    { from: 60, to: 70, count: 6 },
    { from: 70, to: 80, count: 8 },
    { from: 80, to: 90, count: 4 },
    { from: 90, to: 100, count: 2 },
  ],
  /** Student exam session mockup: 12 questions, 9 already answered, viewing question 7. */
  sessionTotalQuestions: 12,
  sessionAnsweredCount: 9,
  sessionCurrentQuestion: 7,
  sessionTimeLeft: "18:42",
  /** Exam builder mockup: a small, plausible question count/point total for the demo exam. */
  builderQuestionCount: 12,
  builderPointsTotal: 24,
} as const;
