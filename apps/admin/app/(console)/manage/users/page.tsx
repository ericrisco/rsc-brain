"use client";

import { useState } from "react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { AlertDialog, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  useCreateUserCredential,
  useDisableUser,
  useInviteUser,
  useMe,
  useMemberships,
  useRequestPasswordReset,
  useRevokeUserCredential,
  useRotateUserCredential,
  useUpdateMembership,
  useUserCredentials,
  useUsers,
} from "@/lib/api/hooks";
import type { CredentialState, UserState } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";

type EphemeralSecret = { kind: "invitation" | "credential" | "reset"; value: string };

export default function UsersPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("users.title")} subtitle={t("users.subtitle")}>
      {(project) => <UsersWorkspace project={project} />}
    </PageShell>
  );
}

function UsersWorkspace({ project }: { project: string }) {
  const { t } = useI18n();
  const users = useUsers(project);
  const me = useMe();
  const memberships = useMemberships(project);
  const invite = useInviteUser(project);
  const disable = useDisableUser(project);
  const resetPassword = useRequestPasswordReset(project);
  const updateMembership = useUpdateMembership(project);
  const createCredential = useCreateUserCredential(project);
  const rotateCredential = useRotateUserCredential(project);
  const revokeCredential = useRevokeUserCredential(project);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = users.data?.items.find((item) => item.id === selectedId) ?? null;
  const credentials = useUserCredentials(project, selectedId);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [projectRole, setProjectRole] = useState("member");
  const [platformRole, setPlatformRole] = useState("member");
  const [inviteTopics, setInviteTopics] = useState("");
  const [inviteCurate, setInviteCurate] = useState(false);
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [credentialName, setCredentialName] = useState("");
  const [membershipOpen, setMembershipOpen] = useState(false);
  const [memberRole, setMemberRole] = useState("member");
  const [memberTopics, setMemberTopics] = useState("");
  const [memberCurate, setMemberCurate] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<CredentialState | null>(null);
  const [secret, setSecret] = useState<EphemeralSecret | null>(null);
  const [error, setError] = useState<string | null>(null);

  const membership = memberships.data?.memberships.find((item) => item.user_id === selected?.id);
  const canAssignPlatformRole = me.data?.platform_capabilities.includes("platform.user.invite") ?? false;

  async function submitInvite() {
    setError(null);
    try {
      const result = await invite.mutateAsync({
        email: email.trim(),
        projectRole,
        platformRole,
        allowedTopics: splitList(inviteTopics),
        canCurate: inviteCurate,
      });
      setInviteOpen(false);
      if (result.invitation_token) setSecret({ kind: "invitation", value: result.invitation_token });
    } catch {
      setError(t("users.commandError"));
    }
  }

  async function submitCredential() {
    if (!selected) return;
    setError(null);
    try {
      const result = await createCredential.mutateAsync({ userId: selected.id, name: credentialName.trim(), kind: "pat" });
      setCredentialOpen(false);
      if (result.secret) setSecret({ kind: "credential", value: result.secret });
    } catch {
      setError(t("users.commandError"));
    }
  }

  async function submitMembership() {
    if (!selected || !membership) return;
    setError(null);
    try {
      await updateMembership.mutateAsync({
        userId: selected.id,
        expectedVersion: membership.version,
        role: memberRole,
        allowedTopics: splitList(memberTopics),
        canCurate: memberCurate,
      });
      setMembershipOpen(false);
    } catch {
      setError(t("users.commandError"));
    }
  }

  async function requestReset() {
    if (!selected) return;
    setError(null);
    try {
      const result = await resetPassword.mutateAsync(selected.id);
      if (result.reset_token) setSecret({ kind: "reset", value: result.reset_token });
    } catch {
      setError(t("users.commandError"));
    }
  }

  async function rotateUserCredential(credential: CredentialState) {
    setError(null);
    try {
      const result = await rotateCredential.mutateAsync({
        credentialId: credential.id,
        expectedVersion: credential.version,
      });
      if (result.secret) setSecret({ kind: "credential", value: result.secret });
    } catch {
      setError(t("users.commandError"));
    }
  }

  async function disableSelectedUser() {
    if (!selected) return;
    setError(null);
    try {
      await disable.mutateAsync({ userId: selected.id, expectedStatus: selected.status });
      setDisableOpen(false);
    } catch {
      setError(t("users.commandError"));
    }
  }

  async function revokeSelectedCredential() {
    if (!revokeTarget) return;
    setError(null);
    try {
      await revokeCredential.mutateAsync({
        credentialId: revokeTarget.id,
        expectedVersion: revokeTarget.version,
      });
      setRevokeTarget(null);
    } catch {
      setError(t("users.commandError"));
    }
  }

  const columns: DataColumn<UserState>[] = [
    { key: "email", label: t("users.email"), render: (user) => <span className="font-medium">{user.email}</span> },
    { key: "role", label: t("users.projectRole"), render: (user) => <Badge tone={user.role === "project-admin" ? "info" : "neutral"}>{user.role}</Badge> },
    { key: "topics", label: t("users.topics"), render: (user) => user.allowed_topics.join(", ") || t("common.none") },
    { key: "status", label: t("users.status"), render: (user) => <Badge tone={user.status === "active" ? "success" : "neutral"}>{user.status}</Badge> },
    {
      key: "manage",
      label: t("users.actions"),
      render: (user) => <Button size="sm" variant="outline" aria-label={t("users.manageNamed", { email: user.email })} onClick={() => setSelectedId(user.id)}>{t("users.manage")}</Button>,
    },
  ];

  return (
    <div className="space-y-5">
      <section aria-label={t("users.accessRegion")}>
        <Banner title={t("users.projectAccess", { project })} actions={<Button onClick={() => setInviteOpen(true)}>{t("users.invite")}</Button>}>
          {t("users.accessHelp")}
        </Banner>
      </section>
      {secret ? <SecretPanel secret={secret} onDismiss={() => setSecret(null)} /> : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.75fr)]">
        <Card>
          <CardHeader><CardTitle>{t("users.directory")}</CardTitle><CardDescription>{t("users.directoryHelp")}</CardDescription></CardHeader>
          <CardContent>
            {users.isError ? <p role="alert" className="text-sm text-danger">{t("users.loadError")}</p> : null}
            {!users.isLoading && !users.isError ? <DataTable caption={t("users.table")} columns={columns} rows={users.data?.items ?? []} rowKey={(user) => user.id} emptyTitle={t("users.empty")} /> : null}
          </CardContent>
        </Card>
        <UserDetail
          project={project}
          user={selected}
          credentials={credentials.data?.items ?? []}
          onEditMembership={() => {
            if (!membership) return;
            setMemberRole(membership.role);
            setMemberTopics(membership.allowed_topics.join(", "));
            setMemberCurate(membership.can_curate);
            setMembershipOpen(true);
          }}
          onCreateCredential={() => setCredentialOpen(true)}
          onRotate={rotateUserCredential}
          onRevoke={setRevokeTarget}
          onReset={() => void requestReset()}
          onDisable={() => setDisableOpen(true)}
        />
      </div>

      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} title={t("users.invite")} description={t("users.inviteHelp")} actions={<Button disabled={!email.trim() || invite.isPending} onClick={() => void submitInvite()}>{t("users.createInvitation")}</Button>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("users.email")} wide><Input aria-label={t("users.email")} type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
          <Field label={t("users.projectRole")}><Select aria-label={t("users.projectRole")} value={projectRole} onChange={(event) => setProjectRole(event.target.value)}><option value="member">member</option><option value="viewer">viewer</option><option value="project-admin">project-admin</option></Select></Field>
          <Field label={t("users.platformRole")}><Select aria-label={t("users.platformRole")} value={platformRole} disabled={!canAssignPlatformRole} onChange={(event) => setPlatformRole(event.target.value)}><option value="member">member</option>{canAssignPlatformRole ? <option value="admin">admin</option> : null}</Select></Field>
          <Field label={t("users.topics")} wide><Input aria-label={t("users.topics")} value={inviteTopics} onChange={(event) => setInviteTopics(event.target.value)} placeholder={t("users.topicsPlaceholder")} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={inviteCurate} onChange={(event) => setInviteCurate(event.target.checked)} />{t("users.canCurate")}</label>
        </div>
      </Dialog>

      <Dialog open={credentialOpen} onClose={() => setCredentialOpen(false)} title={t("users.createCredential")} description={selected?.email} actions={<Button disabled={!selected || createCredential.isPending} onClick={() => void submitCredential()}>{t("users.createCredential")}</Button>}>
        <Field label={t("users.credentialName")}><Input aria-label={t("users.credentialName")} value={credentialName} onChange={(event) => setCredentialName(event.target.value)} /></Field>
      </Dialog>

      <Dialog open={membershipOpen} onClose={() => setMembershipOpen(false)} title={t("users.editMembership")} description={membership ? t("users.versionedMembership", { version: membership.version }) : undefined} actions={<Button disabled={!membership || updateMembership.isPending} onClick={() => void submitMembership()}>{t("users.saveAccess")}</Button>}>
        <div className="grid gap-4">
          <Field label={t("users.projectRole")}><Select aria-label={t("users.projectRole")} value={memberRole} onChange={(event) => setMemberRole(event.target.value)}><option value="member">member</option><option value="viewer">viewer</option><option value="project-admin">project-admin</option></Select></Field>
          <Field label={t("users.topics")}><Input aria-label={t("users.topics")} value={memberTopics} onChange={(event) => setMemberTopics(event.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={memberCurate} onChange={(event) => setMemberCurate(event.target.checked)} />{t("users.canCurate")}</label>
        </div>
      </Dialog>

      <AlertDialog open={disableOpen} onClose={() => setDisableOpen(false)} title={t("users.disableUser")} description={t("users.disableHelp")} actions={<Button variant="destructive" disabled={!selected || disable.isPending} onClick={() => void disableSelectedUser()}>{t("users.disableNow")}</Button>} />
      <AlertDialog open={!!revokeTarget} onClose={() => setRevokeTarget(null)} title={t("users.revokeCredential")} description={t("users.revokeCredentialHelp")} actions={<Button variant="destructive" disabled={!revokeTarget || revokeCredential.isPending} onClick={() => void revokeSelectedCredential()}>{t("users.revokeNow")}</Button>} />
    </div>
  );
}

function UserDetail({ project, user, credentials, onEditMembership, onCreateCredential, onRotate, onRevoke, onReset, onDisable }: {
  project: string;
  user: UserState | null;
  credentials: CredentialState[];
  onEditMembership: () => void;
  onCreateCredential: () => void;
  onRotate: (credential: CredentialState) => Promise<void>;
  onRevoke: (credential: CredentialState) => void;
  onReset: () => void;
  onDisable: () => void;
}) {
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader><CardTitle>{t("users.detail")}</CardTitle><CardDescription>{user ? user.email : t("users.selectUser")}</CardDescription></CardHeader>
      <CardContent>
        <section aria-label={t("users.detail")} className="space-y-5">
          {user ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Detail label={t("users.project")} value={project} />
                <Detail label={t("users.projectRole")} value={user.role} />
                <Detail label={t("users.topics")} value={user.allowed_topics.join(", ") || t("common.none")} wide />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={onEditMembership}>{t("users.editAccess")}</Button>
                <Button size="sm" variant="outline" onClick={onCreateCredential}>{t("users.createCredential")}</Button>
                <Button size="sm" variant="outline" onClick={onReset}>{t("users.resetPassword")}</Button>
                <Button size="sm" variant="destructive" onClick={onDisable}>{t("users.disable")}</Button>
              </div>
              <div>
                <h3 className="text-sm font-semibold">{t("users.credentials")}</h3>
                <div className="mt-2 space-y-2">
                  {credentials.length ? credentials.map((credential) => (
                    <div key={credential.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3 text-sm">
                      <div><p className="font-medium">{credential.name ?? credential.kind}</p><p className="font-mono text-xs text-text-secondary">{credential.status} · v{credential.version}</p></div>
                      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void onRotate(credential)}>{t("users.rotate")}</Button><Button size="sm" variant="destructive" onClick={() => onRevoke(credential)}>{t("users.revoke")}</Button></div>
                    </div>
                  )) : <p className="text-sm text-text-secondary">{t("users.noCredentials")}</p>}
                </div>
              </div>
            </>
          ) : <p className="text-sm text-text-secondary">{t("users.selectUserHelp")}</p>}
        </section>
      </CardContent>
    </Card>
  );
}

function SecretPanel({ secret, onDismiss }: { secret: EphemeralSecret; onDismiss: () => void }) {
  const { t } = useI18n();
  const label = secret.kind === "invitation" ? t("users.invitationSecret") : secret.kind === "reset" ? t("users.resetSecret") : t("users.credentialSecret");
  return (
    <section aria-label={label} className="rounded-[var(--radius-panel)] border border-warning/40 bg-warning-muted p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-sm font-semibold">{label}</p><p className="mt-1 text-sm text-text-secondary">{t("users.secretOnce")}</p><code className="mt-3 block break-all rounded bg-surface px-3 py-2 text-sm">{secret.value}</code></div>
        <Button size="sm" onClick={onDismiss}>{t("users.stored")}</Button>
      </div>
    </section>
  );
}

function Field({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return <label className={`grid gap-1 text-sm font-medium ${wide ? "sm:col-span-2" : ""}`}>{label}{children}</label>;
}

function Detail({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={wide ? "col-span-2" : undefined}><p className="text-xs uppercase tracking-[0.08em] text-text-secondary">{label}</p><p className="mt-1 break-all">{value}</p></div>;
}

function splitList(value: string) {
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)));
}
