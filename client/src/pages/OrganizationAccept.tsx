import { useAuth } from "@/_core/hooks/useAuth";
import { Loading } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { startLogin } from "@/const";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { Link, useSearch } from "wouter";

/**
 * /organization/accept?token=... -- accepting a staff invite created by `inviteMember`
 * (server/organization/service.ts). No anonymous preview exists for this yet (it's an internal
 * staff invite, not a public share link): the invitee signs in first, then accepts.
 */
export function OrganizationAcceptPage() {
  const token = new URLSearchParams(useSearch()).get("token") ?? "";
  const { user, loading } = useAuth();
  const accept = trpc.organization.acceptInvite.useMutation();

  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <Card>
        <CardContent className="pt-6">
          <h1 className="text-xl font-semibold">{t("org.accept.title")}</h1>
          {accept.isSuccess ? (
            <div className="mt-3 space-y-3 text-sm" role="status">
              <p className="text-success">{t("org.accept.accepted", { workspace: accept.data.workspaceTitle })}</p>
              <Link href="/teacher" className="font-medium text-link underline underline-offset-4">
                {t("org.accept.goToWorkspace")}
              </Link>
            </div>
          ) : (
            <>
              <p className="mt-3 text-sm text-muted-foreground">{t("org.accept.description")}</p>
              <div className="mt-6">
                {loading ? (
                  <Loading />
                ) : !user ? (
                  <Button className="w-full" onClick={() => startLogin()}>
                    {t("org.accept.signIn")}
                  </Button>
                ) : (
                  <Button className="w-full" disabled={!token || accept.isPending} onClick={() => accept.mutate({ token })}>
                    {t("org.accept.accept")}
                  </Button>
                )}
              </div>
              {accept.error && (
                <p role="alert" className="mt-3 text-sm text-destructive">
                  {errorText(accept.error)}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
