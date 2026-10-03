import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isMessageKey, t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc } from "@/lib/trpc";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@shared/auth";
import { TRPCClientError } from "@trpc/client";
import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";

/** The same ?ref= / ?src= / ?campaign= that startLogin forwards to Google, read off the current page. */
function currentAttribution() {
  const here = new URLSearchParams(window.location.search);
  const pick = (key: string) => here.get(key) || undefined;
  return { ref: pick("ref"), src: pick("src") ?? pick("source"), campaign: pick("campaign") };
}

/** Known error codes get their own text; anything else the server rejected as malformed gets `fallback`. */
export function authErrorText(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (isMessageKey(`error.${message}`)) return errorText(error);
  if (error instanceof TRPCClientError && error.data?.code === "BAD_REQUEST") return fallback;
  return errorText(error);
}

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  hint?: string;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="text-sm">
      <label htmlFor={id} className="text-foreground-secondary">{label}</label>
      <div className="relative mt-1">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          required
          minLength={minLength}
          maxLength={PASSWORD_MAX_LENGTH}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10"
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? t("auth.hidePassword") : t("auth.showPassword")}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The secondary sign-in option, shown under the Google button: an "or" divider and a collapsed
 * email + password form with sign-in / create-account modes. Success refetches every query under
 * the new session (e.g. a restricted task's access check), so the page carries on exactly as after
 * a Google round trip back to the same URL.
 */
export function EmailSignIn({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const utils = trpc.useUtils();
  const onSuccess = () => utils.invalidate();
  const login = trpc.auth.passwordLogin.useMutation({ onSuccess });
  const register = trpc.auth.passwordRegister.useMutation({ onSuccess });
  const active = mode === "signIn" ? login : register;

  const switchMode = () => {
    login.reset();
    register.reset();
    setMode(mode === "signIn" ? "signUp" : "signIn");
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "signIn") login.mutate({ email, password, ...currentAttribution() });
    else register.mutate({ name, email, password, ...currentAttribution() });
  };

  return (
    <div className={className}>
      <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="h-px flex-1 bg-border" aria-hidden />
        {t("auth.or")}
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
      {!open ? (
        <Button type="button" variant="outline" className="w-full" onClick={() => setOpen(true)}>
          {t("auth.continueWithEmail")}
        </Button>
      ) : (
        <form className="grid gap-3" onSubmit={submit}>
          <h2 className="text-base font-semibold">{mode === "signIn" ? t("auth.signInTitle") : t("auth.signUpTitle")}</h2>
          {mode === "signUp" && (
            <label className="text-sm">
              <span className="text-foreground-secondary">{t("auth.fullName")}</span>
              <Input className="mt-1" required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          )}
          <label className="text-sm">
            <span className="text-foreground-secondary">{t("common.email")}</span>
            <Input className="mt-1" type="email" required maxLength={191} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <PasswordField
            label={t("auth.password")}
            value={password}
            onChange={setPassword}
            autoComplete={mode === "signIn" ? "current-password" : "new-password"}
            minLength={mode === "signUp" ? PASSWORD_MIN_LENGTH : undefined}
            hint={mode === "signUp" ? t("auth.passwordHint", { count: PASSWORD_MIN_LENGTH }) : undefined}
          />
          {active.error && (
            <p role="alert" className="text-sm text-destructive">
              {authErrorText(active.error, mode === "signIn" ? t("error.INVALID_CREDENTIALS") : t("auth.checkFields"))}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={active.isPending}>
            {mode === "signIn" ? t("auth.signIn") : t("auth.createAccount")}
          </Button>
          {mode === "signIn" && <p className="text-xs text-muted-foreground">{t("auth.forgotPasswordHint")}</p>}
          <button type="button" onClick={switchMode} className="justify-self-start text-sm font-medium text-link underline-offset-4 hover:underline">
            {mode === "signIn" ? t("auth.toSignUp") : t("auth.toSignIn")}
          </button>
        </form>
      )}
    </div>
  );
}
