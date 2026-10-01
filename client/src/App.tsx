import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider, useI18n } from "@/i18n/locale";
import { t } from "@/i18n/messages";
import { canEnter, entryPath, getActiveWorkspaceId, setActiveWorkspaceId, type UiContext } from "@/lib/contexts";
import { trpc } from "@/lib/trpc";
import AdminRoutes from "@/pages/admin/Admin";
import Home from "@/pages/Home";
import NotFound from "@/pages/NotFound";
import PartnerPage from "@/pages/PartnerPage";
import WelcomePage from "@/pages/WelcomePage";
import { JoinGroupPage, PublicEmailInvitePage, PublicExamPage, PublicMaterialPage, PublicTaskPage } from "@/pages/PublicFlows";
import SettingsPage from "@/pages/SettingsPage";
import {
  StudentAssessmentDetail,
  StudentAssessments,
  StudentGroups,
  StudentHome,
  StudentMaterials,
  StudentProgress,
  StudentResultDetail,
  StudentResults,
  StudentTasks,
} from "@/pages/student/StudentPages";
import StudentSession from "@/pages/student/StudentSession";
import { AnalyticsPage } from "@/pages/teacher/Analytics";
import { AssessmentDetailPage, AssessmentsPage } from "@/pages/teacher/Assessments";
import { EditAssessmentPage, NewAssessmentPage } from "@/pages/teacher/ExamBuilder";
import { GroupDetailPage, GroupsPage } from "@/pages/teacher/Groups";
import { AssessmentParticipantsPage } from "@/pages/teacher/Participants";
import { ResultDetailPage, ResultsPage } from "@/pages/teacher/Results";
import TeacherHome from "@/pages/teacher/TeacherHome";
import { AssignmentsPage, LibraryPage, UsagePage } from "@/pages/teacher/TeacherModules";
import { useEffect, useRef } from "react";
import { Redirect, Route, Switch, useLocation, useParams } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { useAuth } from "./_core/hooks/useAuth";

/**
 * UI gate for one activity context. It only decides what to render; every procedure is
 * authorized again on the server from the user's ownership/membership records.
 */
function Guard({ context, children }: { context: UiContext; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [location] = useLocation();
  const utils = trpc.useUtils();
  const remember = trpc.auth.setActiveContext.useMutation();
  const allowed = !!user && canEnter(user, context);

  if (allowed && context === "teaching") {
    const current = getActiveWorkspaceId();
    if (!current || !user.workspaces.some((w) => w.id === current)) setActiveWorkspaceId(user.workspaces[0]?.id ?? null);
  }

  useEffect(() => {
    if (!allowed || user.lastActiveContext === context || remember.isPending) return;
    remember.mutate(
      { context },
      { onSuccess: () => utils.auth.me.setData(undefined, (old) => (old ? { ...old, lastActiveContext: context } : old)) },
    );
  }, [allowed, context, user?.lastActiveContext]);

  if (loading) return <div role="status" className="p-10 text-center text-muted-foreground">{t("app.loading")}</div>;
  if (!user) return <Redirect to={`/?returnTo=${encodeURIComponent(location + window.location.search)}`} />;
  if (!allowed) return <Redirect to={entryPath(user) === location ? "/welcome" : entryPath(user)} />;
  return <>{children}</>;
}

const teacher = (page: React.ReactNode) => () => <Guard context="teaching">{page}</Guard>;
const student = (page: React.ReactNode) => () => <Guard context="learning">{page}</Guard>;
const partner = (page: React.ReactNode) => () => <Guard context="partner">{page}</Guard>;

function LegacySessionRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Redirect to={`/student/sessions/${id}`} />;
}

/**
 * New page → top of the page. Only the pathname counts, so query-string tabs, the question index
 * inside an exam session, autosave, popovers and dialogs never move the viewport. Back/forward
 * keeps the browser's own scroll restoration.
 */
function ScrollReset() {
  const [pathname] = useLocation();
  const previous = useRef(pathname);
  const popped = useRef(false);

  useEffect(() => {
    const onPop = () => {
      popped.current = true;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    if (popped.current) {
      popped.current = false;
      return;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);

  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/login" component={Home} />
      <Route path="/welcome" component={WelcomePage} />
      <Route path="/choose-role">{() => <Redirect to={`/welcome${window.location.search}`} />}</Route>
      <Route path="/join/:inviteCode" component={JoinGroupPage} />
      <Route path="/invite/:token" component={PublicEmailInvitePage} />
      <Route path="/exam/:shareCode" component={PublicExamPage} />
      <Route path="/task/:shareCode" component={PublicTaskPage} />
      <Route path="/material/:shareCode" component={PublicMaterialPage} />
      <Route path="/app">{() => <AppRedirect />}</Route>
      <Route path="/settings" component={SettingsPage} />
      <Route path="/partner">{partner(<PartnerPage />)}</Route>
      <Route path="/admin/:rest*" component={AdminRoutes} />
      <Route path="/admin" component={AdminRoutes} />

      <Route path="/teacher">{teacher(<TeacherHome />)}</Route>
      <Route path="/teacher/assessments">{teacher(<AssessmentsPage />)}</Route>
      <Route path="/teacher/assessments/new">{teacher(<NewAssessmentPage />)}</Route>
      <Route path="/teacher/assessments/:id/edit">{teacher(<EditAssessmentPage />)}</Route>
      <Route path="/teacher/assessments/:id/participants">{teacher(<AssessmentParticipantsPage />)}</Route>
      <Route path="/teacher/assessments/:id">{teacher(<AssessmentDetailPage />)}</Route>
      <Route path="/teacher/groups">{teacher(<GroupsPage />)}</Route>
      <Route path="/teacher/groups/:id">{teacher(<GroupDetailPage />)}</Route>
      <Route path="/teacher/assignments">{teacher(<AssignmentsPage />)}</Route>
      <Route path="/teacher/library">{teacher(<LibraryPage />)}</Route>
      <Route path="/teacher/results">{teacher(<ResultsPage />)}</Route>
      <Route path="/teacher/results/:id">{teacher(<ResultDetailPage />)}</Route>
      <Route path="/teacher/analytics">{teacher(<AnalyticsPage />)}</Route>
      <Route path="/teacher/usage">{teacher(<UsagePage />)}</Route>
      <Route path="/teacher/ksq"><Redirect to="/teacher/assessments?type=KSQ" /></Route>
      <Route path="/teacher/bsq"><Redirect to="/teacher/assessments?type=BSQ" /></Route>
      <Route path="/teacher/exams/new"><Redirect to="/teacher/assessments/new" /></Route>
      <Route path="/teacher/exams/*"><Redirect to="/teacher/assessments" /></Route>
      <Route path="/teacher/exams"><Redirect to="/teacher/assessments?type=EXAM" /></Route>
      <Route path="/teacher/profile"><Redirect to="/settings" /></Route>

      <Route path="/student">{student(<StudentHome />)}</Route>
      <Route path="/student/assessments">{student(<StudentAssessments />)}</Route>
      <Route path="/student/assessments/:id">{student(<StudentAssessmentDetail />)}</Route>
      <Route path="/student/sessions/:id">{student(<StudentSession />)}</Route>
      <Route path="/student/assignments">{student(<StudentTasks />)}</Route>
      <Route path="/student/materials">{student(<StudentMaterials />)}</Route>
      <Route path="/student/groups">{student(<StudentGroups />)}</Route>
      <Route path="/student/results">{student(<StudentResults />)}</Route>
      <Route path="/student/results/:id">{student(<StudentResultDetail />)}</Route>
      <Route path="/student/progress">{student(<StudentProgress />)}</Route>
      <Route path="/student/exams"><Redirect to="/student/assessments?type=EXAM" /></Route>
      <Route path="/student/ksq"><Redirect to="/student/assessments?type=KSQ" /></Route>
      <Route path="/student/bsq"><Redirect to="/student/assessments?type=BSQ" /></Route>
      <Route path="/student/exam/:id" component={LegacySessionRedirect} />
      <Route path="/student/library"><Redirect to="/student/materials" /></Route>
      <Route path="/student/profile"><Redirect to="/settings" /></Route>

      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

/** A suspended account keeps its data but cannot use the app; the server refuses every protected call. */
function SuspendedGate({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  if (user?.accountStatus !== "SUSPENDED") return <>{children}</>;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">{t("app.suspended.title")}</h1>
      <p className="text-muted-foreground">{t("app.suspended.body")}</p>
      <Button variant="outline" onClick={() => logout()}>
        {t("common.logout")}
      </Button>
    </main>
  );
}

function AppRedirect() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect to="/" />;
  return <Redirect to={entryPath(user)} />;
}

/**
 * Subscribes to the locale so a language switch re-renders every route in place.
 * Component state (exam answers, form drafts, open dialogs) is preserved because nothing remounts.
 */
function LocalizedApp() {
  useI18n();
  return (
    <>
      <ScrollReset />
      <SuspendedGate>
        <Router />
      </SuspendedGate>
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <LocaleProvider>
          <TooltipProvider>
            <Toaster />
            <LocalizedApp />
          </TooltipProvider>
        </LocaleProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
