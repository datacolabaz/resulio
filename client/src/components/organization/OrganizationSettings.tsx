import { Panel } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n/messages";
import { errorText } from "@/lib/format";
import { trpc, type RouterOutputs } from "@/lib/trpc";
import { INVITABLE_ROLES, type InvitableRole, type WorkspaceMemberRole } from "@shared/organization";
import { useState } from "react";
import { toast } from "sonner";

const selectClass = "rounded-lg border border-input bg-card px-2 py-1.5 text-sm text-foreground";

type MemberRow = RouterOutputs["organization"]["members"]["list"][number];
type DepartmentRow = RouterOutputs["organization"]["departments"]["list"][number];

const roleLabel = (role: WorkspaceMemberRole) => t(`org.role.${role}` as const);
const statusLabel = (status: MemberRow["displayStatus"]) => t(`org.status.${status}` as const);

const NO_DEPARTMENT = "__none__";

/** Settings → "Komanda və şöbələr". Staff members (invite/role/remove) and departments for this
 * workspace. Only reachable by an OWNER or an org ADMIN -- see server/organization/service.ts. */
export function OrganizationSettings() {
  const utils = trpc.useUtils();
  const members = trpc.organization.members.list.useQuery();
  const departmentsQuery = trpc.organization.departments.list.useQuery();
  const invalidateMembers = () => void utils.organization.members.list.invalidate();
  const invalidateDepartments = () => void utils.organization.departments.list.invalidate();

  return (
    <Panel id="organization" title={t("org.settings.title")} className="scroll-mt-20">
      <p className="text-sm text-muted-foreground">{t("org.settings.description")}</p>
      <div className="mt-5 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("org.members.title")}</h3>
          <MemberList members={members.data ?? []} departments={departmentsQuery.data ?? []} onChanged={invalidateMembers} />
          <InviteForm departments={departmentsQuery.data ?? []} onInvited={invalidateMembers} />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-semibold">{t("org.departments.title")}</h3>
          <DepartmentList departments={departmentsQuery.data ?? []} onChanged={invalidateDepartments} />
        </div>
      </div>
    </Panel>
  );
}

function MemberList({ members, departments, onChanged }: { members: MemberRow[]; departments: DepartmentRow[]; onChanged: () => void }) {
  const update = trpc.organization.members.update.useMutation({
    onSuccess: () => {
      toast.success(t("org.members.roleUpdated"));
      onChanged();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const remove = trpc.organization.members.remove.useMutation({
    onSuccess: () => {
      toast.success(t("org.members.removed"));
      onChanged();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  return (
    <ul className="divide-y rounded-lg border">
      {members.map((m) => (
        <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
          <div className="min-w-0">
            <div className="truncate font-medium">{m.name || m.email}</div>
            <div className="truncate text-xs text-muted-foreground">{m.email}</div>
          </div>
          <div className="flex items-center gap-2">
            {m.role === "OWNER" ? (
              <span className="text-sm font-medium">{roleLabel(m.role)}</span>
            ) : (
              <select
                className={selectClass}
                value={m.role}
                disabled={update.isPending}
                onChange={(e) => update.mutate({ memberId: m.id, role: e.target.value as InvitableRole, departmentId: m.departmentId })}
              >
                {INVITABLE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {roleLabel(role)}
                  </option>
                ))}
              </select>
            )}
            {m.role !== "OWNER" && (
              <select
                className={selectClass}
                value={m.departmentId ?? NO_DEPARTMENT}
                disabled={update.isPending}
                onChange={(e) => update.mutate({ memberId: m.id, role: m.role as InvitableRole, departmentId: e.target.value === NO_DEPARTMENT ? null : e.target.value })}
              >
                <option value={NO_DEPARTMENT}>{t("org.members.noDepartment")}</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
            <span className="text-xs text-muted-foreground">{statusLabel(m.displayStatus)}</span>
            {m.role !== "OWNER" && (
              <Button
                variant="outline"
                size="sm"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(t("org.members.removeConfirm"))) remove.mutate({ memberId: m.id });
                }}
              >
                {t("org.members.remove")}
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function InviteForm({ departments, onInvited }: { departments: DepartmentRow[]; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("TRAINER");
  const [departmentId, setDepartmentId] = useState(NO_DEPARTMENT);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = trpc.organization.members.invite.useMutation({
    onSuccess: ({ token }) => {
      toast.success(t("org.invite.sent"));
      setLink(`${window.location.origin}/organization/accept?token=${token}`);
      setEmail("");
      setCopied(false);
      onInvited();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  return (
    <div className="mt-5 rounded-lg border p-3">
      <h4 className="text-sm font-semibold">{t("org.invite.title")}</h4>
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!email.trim()) return;
          invite.mutate({ email: email.trim(), role, departmentId: departmentId === NO_DEPARTMENT ? null : departmentId });
        }}
      >
        <div className="min-w-[200px] flex-1">
          <label className="text-xs text-muted-foreground" htmlFor="org-invite-email">
            {t("org.invite.email")}
          </label>
          <Input id="org-invite-email" type="email" required placeholder={t("org.invite.emailPlaceholder")} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="org-invite-role">
            {t("org.invite.role")}
          </label>
          <select id="org-invite-role" className={selectClass} value={role} onChange={(e) => setRole(e.target.value as InvitableRole)}>
            {INVITABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
        {departments.length > 0 && (
          <div>
            <label className="text-xs text-muted-foreground" htmlFor="org-invite-department">
              {t("org.members.department")}
            </label>
            <select id="org-invite-department" className={selectClass} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value={NO_DEPARTMENT}>{t("org.members.noDepartment")}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button type="submit" size="sm" disabled={invite.isPending}>
          {t("org.invite.submit")}
        </Button>
      </form>
      {link && (
        <div className="mt-3 rounded-md bg-muted p-2.5 text-sm">
          <div className="font-medium">{t("org.invite.linkTitle")}</div>
          <p className="mt-1 text-xs text-muted-foreground">{t("org.invite.linkHint")}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-card px-2 py-1 text-xs">{link}</code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? t("org.invite.copied") : t("org.invite.copy")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function DepartmentList({ departments, onChanged }: { departments: DepartmentRow[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const create = trpc.organization.departments.create.useMutation({
    onSuccess: () => {
      toast.success(t("org.departments.added"));
      setName("");
      onChanged();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const rename = trpc.organization.departments.rename.useMutation({
    onSuccess: () => {
      setRenaming(null);
      onChanged();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const remove = trpc.organization.departments.remove.useMutation({
    onSuccess: () => {
      toast.success(t("org.departments.removed"));
      onChanged();
    },
    onError: (e) => toast.error(errorText(e)),
  });

  return (
    <div>
      <ul className="divide-y rounded-lg border">
        {departments.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
            {renaming?.id === d.id ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (renaming.name.trim()) rename.mutate({ departmentId: d.id, name: renaming.name.trim() });
                }}
              >
                <Input autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} />
                <Button type="submit" size="sm" disabled={rename.isPending}>
                  {t("org.departments.rename")}
                </Button>
              </form>
            ) : (
              <>
                <span className="truncate text-sm">{d.name}</span>
                <div className="flex items-center gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => setRenaming({ id: d.id, name: d.name })}>
                    {t("org.departments.rename")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (confirm(t("org.departments.removeConfirm"))) remove.mutate({ departmentId: d.id });
                    }}
                  >
                    {t("org.departments.remove")}
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate({ name: name.trim() });
        }}
      >
        <Input placeholder={t("org.departments.namePlaceholder")} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" size="sm" disabled={create.isPending}>
          {t("org.departments.add")}
        </Button>
      </form>
    </div>
  );
}
