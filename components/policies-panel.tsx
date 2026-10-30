"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { api, type Policies, type RepoPolicy } from "@/lib/api";

// Step 3: quirq-ai's repos with their testing pipelines and merge policies, read from the files that
// own them and checked against GitHub's live rulesets. Read only: adding, editing and removing come
// in a later version, after review.

const KIND_TITLE: Record<RepoPolicy["kind"], string> = {
  product: "Products",
  unlisted: "Registered, not behind the gate yet",
  infra: "qq's own repos",
};

const APPLIED: Record<RepoPolicy["ruleset"], { word: string; color: string; outline?: true }> = {
  applied: { word: "applied on GitHub", color: "var(--state-green)" },
  missing: { word: "not applied on GitHub", color: "var(--state-held)" },
  unknown: { word: "could not check GitHub", color: "var(--state-unknown)", outline: true },
};

export function PoliciesPanel() {
  const [data, setData] = useState<Policies | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    api
      .policies()
      .then(setData, (e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3 className="font-display text-lg">Pipelines and policies per repo</h3>
        </CardTitle>
        <CardDescription>
          What each quirq-ai repo is tested with and the rules its pull requests must pass, read from gate and
          infra-config on main, and whether GitHub has them. This version only reads.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!data && (
          <Button variant="outline" onClick={load} disabled={loading} className="w-full sm:w-fit">
            {loading && <Spinner />} {loading ? "Reading quirq-ai's repos…" : "Show quirq-ai's repos and policies"}
          </Button>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {data && (
          <>
            {(["product", "unlisted", "infra"] as const).map((kind) => {
              const repos = data.repos.filter((r) => r.kind === kind);
              if (!repos.length) return null;
              return (
                <section key={kind} aria-label={KIND_TITLE[kind]} className="flex flex-col gap-2">
                  <h4 className="text-sm font-medium">
                    {KIND_TITLE[kind]} ({repos.length})
                  </h4>
                  <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {repos.map((r) => (
                      <li key={r.name}>
                        <RepoRow repo={r} ruleset={data.ruleset} />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            <p className="text-sm text-muted-foreground">
              Read from {data.read.map((r) => r.file).join(", ")} and each repo&apos;s CODEOWNERS. Until editing
              lands here, change these through a pull request on those files (the monitoring site&apos;s settings
              page opens one for a value), and an org admin runs gate&apos;s settings apply to put merge rules on
              GitHub.
            </p>
            <Button variant="outline" size="sm" onClick={load} disabled={loading} className="w-fit">
              {loading && <Spinner />} Read again
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RepoRow({ repo: r, ruleset }: { repo: RepoPolicy; ruleset: string }) {
  const applied = APPLIED[r.gated ? r.ruleset : "missing"];
  return (
    <Collapsible className="group/repo">
      <CollapsibleTrigger className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]/repo:rotate-90" aria-hidden />
        <span className="font-mono break-all">{r.name}</span>
        <span className="flex flex-wrap items-center gap-1">
          {r.kinds.map((k) => (
            <Badge key={k} variant="outline">
              {k}
            </Badge>
          ))}
          <Badge variant="secondary" className="gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={applied.outline ? { border: `1.5px solid ${applied.color}` } : { background: applied.color }}
            />
            {r.gated ? applied.word : "no merge rules yet"}
          </Badge>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3 px-3 pb-3 pl-10 text-sm">
        {r.notes.map((n) => (
          <p key={n} className="text-muted-foreground">
            {n}
          </p>
        ))}
        {r.rulesetNote && <p className="text-muted-foreground">{r.rulesetNote}</p>}
        {r.gated && r.ruleset === "missing" && !r.rulesetNote && (
          <p className="text-muted-foreground">
            gate lists it, but GitHub has no {ruleset} ruleset on it: an org admin has not run gate&apos;s settings
            apply since it was added.
          </p>
        )}

        <Field title="Testing pipelines">
          {r.pipelines.length ? (
            <ul className="flex flex-col gap-0.5">
              {r.pipelines.map((p) => (
                <li key={p.name}>
                  <span className="font-mono break-all">{p.name}</span>: {p.pipeline}, on {p.triggers.join(", ") || "no trigger"}
                  {p.blocking && ", required to merge"}
                  {!p.generated && ", not generated into the repo"}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              {r.kind === "infra" ? "Its own hand-written workflows (not in pipelines.toml yet)." : "None in pipelines.toml."}
            </p>
          )}
        </Field>

        <Field title="Merge rules">
          {r.merge ? (
            <ul className="flex flex-col gap-0.5">
              <li>
                {r.merge.approvals === 0 ? "No approval needed" : `${r.merge.approvals} approval${r.merge.approvals > 1 ? "s" : ""} needed`}
                {r.merge.codeOwnerReview && ", from a code owner"}
              </li>
              <li>Auto-merge {r.merge.autoMerge ? "allowed" : "off: pull requests land by hand"}</li>
              <li>
                Required checks {r.merge.checksFrom === "pipelines" ? "(from its required pipelines)" : "(listed in gate's settings)"}:{" "}
                {r.merge.checks.length ? <span className="font-mono break-all">{r.merge.checks.join(", ")}</span> : "none"}
              </li>
              {r.merge.extra.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">None: gate&apos;s settings do not list this repo.</p>
          )}
        </Field>

        {(r.channels.length > 0 || r.deploy) && (
          <Field title="Release">
            <p>
              {r.channels.length ? `Channels: ${r.channels.join(", ")}` : "Not in the canary"}
              {r.deploy && `; deploys to ${r.deploy}`}
            </p>
          </Field>
        )}

        <Field title="Code owners">
          {r.ownersError ? (
            <p className="text-muted-foreground">{r.ownersError}</p>
          ) : r.owners?.path ? (
            <ul className="flex flex-col gap-0.5">
              <li className="text-muted-foreground">
                <span className="font-mono">{r.owners.path}</span>
              </li>
              {r.owners.rules.map((o, i) => (
                <li key={`${o.pattern}-${i}`} className="font-mono break-all">
                  {o.pattern} {o.owners.join(" ")}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">No CODEOWNERS file.</p>
          )}
        </Field>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Field({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium">{title}</p>
      {children}
    </div>
  );
}
