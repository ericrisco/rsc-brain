"use client";

import { useState } from "react";

import { Badge } from "./ui/badge";
import { Banner } from "./ui/banner";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { DataTable } from "./ui/data-table";
import { EmptyState } from "./ui/empty-state";
import { FilterBar } from "./ui/filter-bar";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { PageHeader } from "./ui/page-header";
import { Select } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { Tabs } from "./ui/tabs";
import { TrustRail } from "./ui/trust-rail";

const rows = [
  { id: "cred_7F3A", status: "Active", lastUsed: "2026-08-16 17:22" },
  { id: "cred_1B9C", status: "Expires soon", lastUsed: "2026-08-12 09:04" },
];

/** Review fixture for themes, locales, density, states and axe; intentionally not a public route. */
export function DesignSystemCatalog() {
  const [tab, setTab] = useState("components");
  return (
    <div className="space-y-8 bg-canvas p-6 text-text-primary">
      <PageHeader
        eyebrow="Quiet Control Room"
        title="Design-system catalogue"
        description="Monochrome Instrument, Precision Grid and the shared operational primitives."
        actions={<Button>Primary action</Button>}
        meta={
          <>
            <Badge tone="success">Healthy</Badge>
            <Badge tone="warning">Needs attention</Badge>
            <Badge tone="danger">Denied</Badge>
          </>
        }
      />
      <TrustRail
        segments={[
          { id: "knowledge", label: "Knowledge", status: "Stable", detail: "No disputed claims", tone: "success" },
          { id: "operations", label: "Operations", status: "3 pending", detail: "Review ingest queue", tone: "warning" },
          { id: "access", label: "Access", status: "1 risk", detail: "Credential expires soon", tone: "danger" },
          { id: "budget", label: "Budget", status: "62%", detail: "Within current threshold", tone: "neutral" },
        ]}
      />
      <Banner title="Scoped operational notice" tone="info">
        Every value shown here must come from an authoritative project-scoped response.
      </Banner>
      <Tabs
        label="Catalogue areas"
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "components", label: "Components" },
          { value: "states", label: "States", count: 6 },
        ]}
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="space-y-4 border-y border-border py-5">
            <h2 className="text-lg font-semibold">Controls</h2>
            <div className="grid gap-2">
              <Label htmlFor="catalog-search">Search</Label>
              <Input id="catalog-search" placeholder="Search authorized records" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="catalog-scope">Scope</Label>
              <Select id="catalog-scope" defaultValue="project">
                <option value="project">Current project</option>
                <option value="platform">Platform posture</option>
              </Select>
            </div>
            <Checkbox id="catalog-denied" label="Denied events only" />
            <div className="flex flex-wrap gap-2">
              <Button>Continue</Button>
              <Button variant="outline">Secondary</Button>
              <Button variant="destructive">Revoke</Button>
            </div>
          </section>
          <section className="space-y-4 border-y border-border py-5">
            <h2 className="text-lg font-semibold">Loading and empty</h2>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
            <EmptyState title="No matching credentials" description="Change the filters or create a credential." />
          </section>
        </div>
      </Tabs>
      <section className="space-y-4">
        <FilterBar actions={<Button variant="outline">Clear filters</Button>}>
          <Badge>Project: atlas</Badge>
          <Badge>Status: active</Badge>
        </FilterBar>
        <DataTable
          caption="Credential review fixture"
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "id", label: "Credential", render: (row) => <code>{row.id}</code> },
            { key: "status", label: "Status", render: (row) => row.status },
            { key: "lastUsed", label: "Last used", align: "right", render: (row) => <time>{row.lastUsed}</time> },
          ]}
        />
      </section>
    </div>
  );
}
