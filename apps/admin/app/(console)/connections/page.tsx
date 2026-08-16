"use client";

import { useState, type FormEvent } from "react";

import { PageShell } from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { TrustRail, type TrustSegment } from "@/components/ui/trust-rail";
import { useCreatePat, usePats, useRevokePat } from "@/lib/api/hooks";
import type { Pat } from "@/lib/api/types";
import { useI18n } from "@/lib/i18n/context";
import { formatDate } from "@/lib/i18n/format";

export default function ConnectionsPage() {
  const { t } = useI18n();
  return (
    <PageShell title={t("connections.title")} subtitle={t("connections.subtitle")}>
      {(project) => <ConnectionsSurface project={project} />}
    </PageShell>
  );
}

function ConnectionsSurface({ project }: { project: string }) {
  const { t, locale } = useI18n();
  const patsQuery = usePats();
  const createPat = useCreatePat();
  const revokePat = useRevokePat();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Pat | null>(null);
  const [mutationError, setMutationError] = useState(false);

  const projectPats = (patsQuery.data?.pats ?? []).filter((pat) => pat.project === project);
  const activeCount = projectPats.filter((pat) => !pat.revoked).length;
  const segments: TrustSegment[] = [
    {
      id: "credentials",
      label: t("connections.postureCredentials"),
      status: String(activeCount),
      detail: t("connections.postureCredentialsDetail", { project }),
      tone: "neutral",
    },
    {
      id: "scope",
      label: t("connections.postureScope"),
      status: t("connections.scoped"),
      detail: project,
      tone: "success",
    },
    {
      id: "secrets",
      label: t("connections.postureSecrets"),
      status: t("connections.enforced"),
      detail: t("connections.postureSecretsDetail"),
      tone: "success",
    },
    {
      id: "oauth",
      label: "OAuth",
      status: t("connections.unavailableShort"),
      detail: t("connections.oauthPostureDetail"),
      tone: "neutral",
    },
  ];

  const columns: DataColumn<Pat>[] = [
    {
      key: "name",
      label: t("connections.name"),
      render: (pat) => (
        <div>
          <p className="font-medium">{pat.name ?? t("connections.unnamed")}</p>
          <p className="mt-0.5 font-mono text-xs text-text-tertiary">{pat.id}</p>
        </div>
      ),
    },
    { key: "type", label: t("connections.type"), render: () => "PAT" },
    { key: "project", label: t("common.project"), render: (pat) => pat.project },
    {
      key: "created",
      label: t("connections.created"),
      render: (pat) => formatDate(pat.created_at, locale),
    },
    {
      key: "expiry",
      label: t("connections.expiry"),
      render: (pat) =>
        pat.expires_at ? formatDate(pat.expires_at, locale) : t("connections.noExpiry"),
    },
    {
      key: "status",
      label: t("connections.status"),
      render: (pat) => (
        <Badge tone={pat.revoked ? "neutral" : "success"}>
          {pat.revoked ? t("connections.revoked") : t("connections.active")}
        </Badge>
      ),
    },
    {
      key: "actions",
      label: t("connections.actions"),
      align: "right",
      render: (pat) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={pat.revoked || revokePat.isPending}
          aria-label={t("connections.revokeNamed", {
            name: pat.name ?? t("connections.unnamed"),
          })}
          onClick={() => {
            setMutationError(false);
            setRevokeTarget(pat);
          }}
        >
          {t("connections.revoke")}
        </Button>
      ),
    },
  ];

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setMutationError(false);
    try {
      const created = await createPat.mutateAsync({ project, name: name.trim() });
      setCreateOpen(false);
      setFreshToken(created.token);
      setCopied(false);
      setName("");
    } catch {
      setMutationError(true);
    }
  }

  async function onRevoke() {
    if (!revokeTarget) return;
    setMutationError(false);
    try {
      await revokePat.mutateAsync(revokeTarget.id);
      setRevokeTarget(null);
    } catch {
      setMutationError(true);
    }
  }

  async function copySecret() {
    if (!freshToken) return;
    await navigator.clipboard.writeText(freshToken);
    setCopied(true);
  }

  return (
    <div className="space-y-8">
      <TrustRail segments={segments} label={t("connections.postureLabel")} />

      {mutationError ? (
        <Banner tone="danger" title={t("connections.mutationError")}>
          {t("common.tryAgain")}
        </Banner>
      ) : null}

      {freshToken ? (
        <section
          role="region"
          aria-label={t("connections.newSecretRegion")}
          className="border-l-2 border-l-warning border-y border-r border-border bg-warning-muted px-5 py-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-warning">
                {t("connections.oneTimeSecret")}
              </p>
              <h2 className="mt-1 text-lg font-semibold">{t("connections.copyNow")}</h2>
              <p className="mt-1 max-w-2xl text-sm text-text-secondary">
                {t("connections.secretWarning")}
              </p>
            </div>
            <Badge tone="warning">{t("connections.shownOnce")}</Badge>
          </div>
          <code className="mt-4 block overflow-x-auto border border-warning/40 bg-surface px-3 py-3 font-mono text-sm text-text-primary">
            {freshToken}
          </code>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" onClick={copySecret}>
              {copied ? t("connections.copied") : t("connections.copySecret")}
            </Button>
            <Button onClick={() => setFreshToken(null)}>{t("connections.stored")}</Button>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="credential-inventory-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-interactive">
              {t("connections.inventoryEyebrow")}
            </p>
            <h2 id="credential-inventory-title" className="mt-1 text-xl font-semibold">
              {t("connections.inventoryTitle")}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {t("connections.inventoryDescription", { project })}
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>{t("connections.createCredential")}</Button>
        </div>

        {patsQuery.isLoading ? <Skeleton className="h-48 w-full" /> : null}
        {patsQuery.isError ? (
          <Banner tone="danger" title={t("connections.loadError")}>
            {t("common.tryAgain")}
          </Banner>
        ) : null}
        {!patsQuery.isLoading && !patsQuery.isError ? (
          <DataTable
            caption={t("connections.tableLabel")}
            columns={columns}
            rows={projectPats}
            rowKey={(pat) => pat.id}
            emptyTitle={t("connections.empty")}
            emptyDescription={t("connections.emptyDescription")}
          />
        ) : null}
      </section>

      <section className="border-y border-border py-6" aria-labelledby="oauth-connections-title">
        <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
          <div>
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.12em] text-text-secondary">
              {t("connections.integrationEyebrow")}
            </p>
            <h2 id="oauth-connections-title" className="mt-1 text-lg font-semibold">
              {t("connections.oauthTitle")}
            </h2>
          </div>
          <div>
            <p className="font-medium">{t("connections.notAvailable")}</p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {t("connections.oauthBody")}
            </p>
          </div>
        </div>
      </section>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("connections.createDialogTitle")}
        description={t("connections.createDialogDescription")}
        cancelLabel={t("common.cancel")}
        actions={
          <Button
            type="submit"
            form="create-pat-form"
            disabled={!name.trim() || createPat.isPending}
          >
            {createPat.isPending ? t("connections.creating") : t("connections.createToken")}
          </Button>
        }
      >
        <form id="create-pat-form" onSubmit={onCreate} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="pat-name">{t("connections.name")}</Label>
            <Input
              id="pat-name"
              required
              autoComplete="off"
              value={name}
              placeholder={t("connections.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="border-l-2 border-l-interactive bg-surface-subtle px-3 py-3 text-sm">
            <span className="text-text-secondary">{t("common.project")}: </span>
            <strong>{project}</strong>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={t("connections.revokeDialogTitle")}
        description={t("connections.revokeImmediate")}
        cancelLabel={t("common.cancel")}
        destructive
        actions={
          <Button variant="destructive" disabled={revokePat.isPending} onClick={onRevoke}>
            {revokePat.isPending ? t("connections.revoking") : t("connections.revokeNow")}
          </Button>
        }
      >
        {revokeTarget ? (
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-text-secondary">{t("connections.credential")}</dt>
            <dd className="font-medium">{revokeTarget.name ?? t("connections.unnamed")}</dd>
            <dt className="text-text-secondary">{t("common.project")}</dt>
            <dd className="font-medium">{revokeTarget.project}</dd>
          </dl>
        ) : null}
      </Dialog>
    </div>
  );
}
