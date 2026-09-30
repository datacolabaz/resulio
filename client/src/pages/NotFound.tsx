import { Button } from "@/components/ui/button";
import { t } from "@/i18n/messages";
import { AlertCircle, Home } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background p-4 text-foreground">
      <div className="w-full max-w-lg rounded-2xl border bg-card p-8 text-center shadow-card">
        <AlertCircle className="mx-auto mb-6 h-16 w-16 text-destructive" aria-hidden />
        <h1 className="mb-2 text-4xl font-bold">404</h1>
        <h2 className="mb-4 text-xl font-semibold text-foreground-secondary">{t("app.notFound.title")}</h2>
        <p className="mb-8 text-foreground-secondary">{t("app.notFound.body")}</p>
        <Button asChild>
          <Link href="/">
            <Home className="h-4 w-4" aria-hidden />
            {t("app.notFound.home")}
          </Link>
        </Button>
      </div>
    </main>
  );
}
