import { t } from "@/i18n/messages";
import { cn } from "@/lib/utils";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">
          <div className="flex w-full max-w-2xl flex-col items-center p-8 text-center">
            <AlertTriangle size={48} className="mb-6 shrink-0 text-destructive" aria-hidden />
            <h2 className="mb-2 text-xl">{t("app.error.title")}</h2>
            <p className="mb-6 text-sm text-muted-foreground">{t("app.error.body")}</p>

            {import.meta.env.DEV && (
              <div className="mb-6 w-full overflow-auto rounded bg-muted p-4 text-left">
                <pre className="whitespace-break-spaces text-sm text-muted-foreground">{this.state.error?.stack}</pre>
              </div>
            )}

            <button
              type="button"
              onClick={() => window.location.reload()}
              className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-4 py-2", "bg-primary text-primary-foreground hover:opacity-90")}
            >
              <RotateCcw size={16} aria-hidden />
              {t("app.error.reload")}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
