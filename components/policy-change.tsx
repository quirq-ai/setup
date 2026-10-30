"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Command } from "@/components/command";
import { api, type Policies, type PolicyPlan, type PolicyRequest, type PolicyStep } from "@/lib/api";

// Step 3's writes: add a product repo, change a gated repo's merge rules, or take a product out of
// qq. Planning clones gate and infra-config and runs their own tools on this machine; nothing is
// written until Open, which makes one branch and one pull request through the person's gh login.
// Merging, and applying gate's settings on GitHub, stay with people.

type Op = PolicyRequest["op"];

const OPS: { op: Op; label: string; hint: string }[] = [
  { op: "add", label: "Add a product repo", hint: "List it in infra-config with its pipelines, give it its workflows, and put it behind the gate." },
  { op: "edit", label: "Change a repo's merge rules", hint: "Approvals, auto-merge and code-owner review, in gate's settings." },
  { op: "remove", label: "Take a product repo out of qq", hint: "Its entries in infra-config and gate go. The repo and its code stay." },
];

const STATE: Record<PolicyStep["state"], { word: string; color: string; outline?: true }> = {
  done: { word: "done", color: "var(--state-green)" },
  open: { word: "pull request open", color: "var(--state-pending)" },
  ready: { word: "ready to open", color: "var(--state-pending)", outline: true },
  waiting: { word: "waits on the step before", color: "var(--state-unknown)", outline: true },
  refused: { word: "refused", color: "var(--state-red)" },
  manual: { word: "for a person", color: "var(--state-held)" },
};

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function PolicyChange({ data }: { data: Policies }) {
  const [op, setOp] = useState<Op>("add");
  const gated = data.repos.filter((r) => r.gated);
  // Products, and repos infra-config lists as products that gate does not have yet.
  const removable = data.repos.filter((r) => r.kind === "product" || (r.kind === "unlisted" && r.kinds.length > 0));
  const [repo, setRepo] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [description, setDescription] = useState("");
  const [approvals, setApprovals] = useState("1");
  const [autoMerge, setAutoMerge] = useState(true);
  const [codeOwnerReview, setCodeOwnerReview] = useState(false);
  const [plan, setPlan] = useState<PolicyPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pick(next: Op) {
    setOp(next);
    setPlan(null);
    setError(null);
    setRepo("");
  }

  function pickRepo(name: string) {
    setRepo(name);
    setPlan(null);
    const r = data.repos.find((x) => x.name === name);
    if (op === "edit" && r?.merge) {
      setApprovals(String(r.merge.approvals));
      setAutoMerge(r.merge.autoMerge ?? false);
      setCodeOwnerReview(r.merge.codeOwnerReview);
    }
  }

  const n = Number(approvals);
  const approvalsOk = /^\d{1,2}$/.test(approvals) && n >= 0 && n <= 10;
  const current = data.repos.find((x) => x.name === repo);

  function request(): PolicyRequest | string {
    if (!NAME.test(repo)) return "Name a repo: letters, digits, dot, dash or underscore.";
    if (op === "remove") return { op, repo };
    if (!approvalsOk) return "Approvals must be a whole number from 0 to 10.";
    if (op === "add") {
      if (!kinds.length) return "Pick at least one kind: it decides the repo's pipelines.";
      if (!description.trim()) return "Say in one line what the repo is: infra-config lists it.";
      return { op, repo, kinds, description, fields: { approvals: n, autoMerge, ...(codeOwnerReview ? { codeOwnerReview } : {}) } };
    }
    const m = current?.merge;
    const fields = {
      ...(m?.approvals !== n ? { approvals: n } : {}),
      // Unset in gate (GitHub keeps the repo's own setting) reads as unchecked: sent only when ticked.
      ...((m?.autoMerge ?? false) !== autoMerge ? { autoMerge } : {}),
      ...(m?.codeOwnerReview !== codeOwnerReview ? { codeOwnerReview } : {}),
    };
    if (!Object.keys(fields).length) return "Nothing to change: these are its values now.";
    return { op, repo, fields };
  }

  function makePlan() {
    const req = request();
    if (typeof req === "string") return setError(req);
    setPlanning(true);
    setError(null);
    setPlan(null);
    api
      .policyPlan(req)
      .then(setPlan, (e: Error) => setError(e.message))
      .finally(() => setPlanning(false));
  }

  return (
    <section aria-labelledby="policy-change" className="flex flex-col gap-4 rounded-md border border-border p-3 sm:p-4">
      <div className="flex flex-col gap-1">
        <h4 id="policy-change" className="font-medium">
          Add, change or remove a repo
        </h4>
        <p className="text-sm text-muted-foreground">
          Each change becomes pull requests in quirq-ai, opened through your gh login after you read their diffs here.
          Nothing is merged or applied for you: you merge each pull request on GitHub, and an org admin applies
          gate&apos;s settings.
        </p>
      </div>

      <RadioGroup value={op} onValueChange={(v) => pick(v as Op)} aria-label="What to do" className="gap-2">
        {OPS.map((o) => (
          <Label key={o.op} className="flex min-h-11 items-start gap-3 font-normal">
            <RadioGroupItem value={o.op} className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{o.label}</span>
              <span className="text-muted-foreground">{o.hint}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>

      <div className="flex flex-col gap-3">
        {op === "add" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-repo">Repo in quirq-ai (public, with at least one commit)</Label>
            <Input id="policy-repo" value={repo} onChange={(e) => (setRepo(e.target.value.trim()), setPlan(null))} autoComplete="off" spellCheck={false} className="font-mono sm:max-w-sm" />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-repo">Repo</Label>
            <NativeSelect id="policy-repo" value={repo} onChange={(e) => pickRepo(e.target.value)} className="font-mono">
              <option value="">Pick a repo</option>
              {(op === "edit" ? gated : removable).map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}

        {op === "add" && (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Kinds (what its pipelines build and test)</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {data.kinds.map((k) => (
                  <Label key={k.name} className="flex min-h-11 items-center gap-2 font-normal">
                    <Checkbox
                      checked={kinds.includes(k.name)}
                      onCheckedChange={(on) => (setKinds((ks) => (on === true ? [...ks, k.name] : ks.filter((x) => x !== k.name))), setPlan(null))}
                    />
                    <span className="font-mono">{k.name}</span>
                  </Label>
                ))}
              </div>
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-description">One line on what it is</Label>
              <Input id="policy-description" value={description} maxLength={200} onChange={(e) => (setDescription(e.target.value), setPlan(null))} className="sm:max-w-xl" />
            </div>
          </>
        )}

        {op !== "remove" && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-approvals">Approvals a pull request needs (0 to 10)</Label>
              <Input
                id="policy-approvals"
                inputMode="numeric"
                value={approvals}
                aria-invalid={!approvalsOk}
                onChange={(e) => (setApprovals(e.target.value.trim()), setPlan(null))}
                className="w-24 font-mono"
              />
            </div>
            <Label className="flex min-h-11 items-center gap-2 font-normal">
              <Checkbox checked={autoMerge} onCheckedChange={(on) => (setAutoMerge(on === true), setPlan(null))} />
              Allow auto-merge (a pull request lands by itself once its checks and approvals pass)
            </Label>
            {op === "edit" && current?.merge && current.merge.autoMerge === null && (
              <p className="text-sm text-muted-foreground">
                gate does not set auto-merge for {current.name} now, so GitHub keeps the repo&apos;s own setting. Left
                unticked, that stays so; ticked, gate turns it on.
              </p>
            )}
            <Label className="flex min-h-11 items-center gap-2 font-normal">
              <Checkbox checked={codeOwnerReview} onCheckedChange={(on) => (setCodeOwnerReview(on === true), setPlan(null))} />
              Approval must come from a code owner (CODEOWNERS)
            </Label>
          </div>
        )}

        {op === "remove" && (
          <p className="text-sm">
            What stays: the repo, its code, its qq-*.yml workflows and every ruleset already on GitHub (qq-main
            included, which keeps gating its pull requests). The plan lists the rulesets and how an admin deletes them.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Button onClick={makePlan} disabled={planning} className="w-full sm:w-fit">
          {planning && <Spinner />} {planning ? "Planning…" : "Plan the pull requests"}
        </Button>
        {planning && (
          <p className="text-sm text-muted-foreground" role="status">
            Cloning gate and infra-config and running their own tools here. The first plan also builds gate&apos;s Python
            environment, which takes a minute or two.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      {plan && <PlanSteps plan={plan} onAgain={makePlan} />}
    </section>
  );
}

function PlanSteps({ plan, onAgain }: { plan: PolicyPlan; onAgain: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <h5 className="text-sm font-medium">
        Plan for <span className="font-mono">{plan.repo}</span>, in order
      </h5>
      <ol className="flex flex-col gap-3">
        {plan.steps.map((s, i) => (
          <li key={s.key} className="flex flex-col gap-2 rounded-md border border-border p-3">
            <StepView n={i + 1} step={s} planId={plan.id} />
          </li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">
        A step that waits is planned once the one before it is merged: merge it on GitHub, then plan again. Planning again
        also picks up where an earlier run stopped.
      </p>
      <Button variant="outline" size="sm" onClick={onAgain} className="w-fit">
        Plan again
      </Button>
    </div>
  );
}

function StepView({ n, step: s, planId }: { n: number; step: PolicyStep; planId: string }) {
  const [opening, setOpening] = useState(false);
  const [url, setUrl] = useState<string | null>(s.url ?? null);
  const [error, setError] = useState<string | null>(null);
  const st = STATE[url && s.state === "ready" ? "open" : s.state];

  function open() {
    setOpening(true);
    setError(null);
    api
      .policyOpen(planId, s.key)
      .then((r) => setUrl(r.url), (e: Error) => setError(e.message))
      .finally(() => setOpening(false));
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">
          {n}. {s.title}
        </span>
        <Badge variant="secondary" className="gap-1.5">
          <span
            aria-hidden
            className="size-2 rounded-full"
            style={st.outline ? { border: `1.5px solid ${st.color}` } : { background: st.color }}
          />
          {st.word}
        </Badge>
      </div>
      <p className="text-sm">{s.detail}</p>
      {s.notes?.map((note) => (
        <Alert key={note}>
          <AlertTitle>Good to know</AlertTitle>
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      ))}
      {s.files && (
        <p className="text-sm text-muted-foreground">
          Files: <span className="font-mono break-all">{s.files.join(", ")}</span>
        </p>
      )}
      {s.diff && <Diff text={s.diff} label={`Changes to ${s.repo}`} />}
      {s.command && <Command label={s.title}>{s.command}</Command>}
      {s.state === "ready" && !url && (
        <Button onClick={open} disabled={opening} className="w-full sm:w-fit">
          {opening && <Spinner />} {opening ? "Opening…" : `Open this pull request in ${s.repo}`}
        </Button>
      )}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 w-fit items-center gap-1.5 text-sm underline underline-offset-4">
          The pull request on GitHub <ExternalLink className="size-4" aria-hidden />
        </a>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/** A unified diff, as git prints it. Fetched files are text: rendered as text, never as HTML. */
function Diff({ text, label }: { text: string; label: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label={label}
      className="max-h-[32rem] overflow-auto rounded-md border border-border bg-muted py-2 font-mono text-xs leading-5 focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      {lines.map((l, i) => (
        <span key={i} className={`block px-3 whitespace-pre ${lineClass(l)}`}>
          {l || " "}
        </span>
      ))}
    </pre>
  );
}

function lineClass(l: string) {
  if (l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff --git") || l.startsWith("index ")) return "font-semibold";
  if (l.startsWith("+")) return "bg-[color-mix(in_oklab,var(--state-green)_18%,transparent)]";
  if (l.startsWith("-")) return "bg-[color-mix(in_oklab,var(--state-red)_18%,transparent)]";
  if (l.startsWith("@@")) return "text-muted-foreground";
  return "";
}

