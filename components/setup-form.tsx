"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import {
  api,
  keyFromHash,
  KIND_LABELS,
  STARTER_LABELS,
  type RepoList,
  type StarterKind,
  type State,
} from "@/lib/api";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// The key lives in the fragment of the link the terminal printed. undefined while prerendering.
function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

export function SetupForm() {
  const key = useSyncExternalStore(
    subscribeHash,
    () => keyFromHash(window.location.hash),
    () => undefined,
  );
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [org, setOrg] = useState<string>("");
  const [list, setList] = useState<RepoList | null>(null);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [starterOn, setStarterOn] = useState(false);
  const [starterName, setStarterName] = useState("");
  const [starterKind, setStarterKind] = useState<StarterKind>("node-app");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const latestOrg = useRef("");

  const chooseOrg = useCallback(
    (login: string) => {
      if (!key) return;
      latestOrg.current = login;
      setOrg(login);
      setList(null);
      setPicked(new Set());
      setError(null);
      setLoadingRepos(true);
      api
        .repos(key, login)
        .then(
          (l) => latestOrg.current === login && setList(l),
          (e: Error) => latestOrg.current === login && setError(e.message),
        )
        .finally(() => latestOrg.current === login && setLoadingRepos(false));
    },
    [key],
  );

  useEffect(() => {
    if (!key) return;
    api.state(key).then(
      (s) => {
        setState(s);
        const usable = s.orgs.filter((o) => o.usable);
        if (usable.length === 1) chooseOrg(usable[0].login);
      },
      (e: Error) => setError(e.message),
    );
  }, [key, chooseOrg]);

  if (key === undefined) return null;
  if (key === null) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Open this page from your terminal</AlertTitle>
        <AlertDescription>
          Run <code className="font-mono">npx github:quirq-ai/setup#&lt;commit&gt;</code> and use the link it prints.
        </AlertDescription>
      </Alert>
    );
  }
  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-display text-xl">
            <CircleCheck className="size-6 text-[var(--state-green)]" aria-hidden />
            Back to your terminal
          </CardTitle>
          <CardDescription>
            qq-setup has your answers and shows the plan there. You can close this tab.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const starterError =
    starterOn && starterName && !NAME_RE.test(starterName)
      ? "Letters, digits, '.', '_' and '-' only."
      : starterOn && list?.repos.some((r) => r.name.toLowerCase() === starterName.toLowerCase())
        ? `${org} already has a repo with this name.`
        : null;
  const canSend =
    !!org && !sending && (picked.size > 0 || (starterOn && !!starterName && !starterError));

  async function send() {
    if (!key) return;
    setSending(true);
    setError(null);
    try {
      await api.submit(key, {
        org,
        repos: [...picked],
        starter: starterOn ? { name: starterName, kind: starterKind } : null,
      });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const usableRepos = list?.repos.filter((r) => r.usable) ?? [];
  const otherRepos = list?.repos.filter((r) => !r.usable) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-2xl">Set up qq for your GitHub org</h1>
        <p className="text-muted-foreground">
          Pick an org and the repos to put under qq. Your answers go back to the terminal, which shows
          the plan before anything happens.
        </p>
        {state?.readOnly && (
          <p className="text-sm text-muted-foreground">
            This version only shows the plan. It creates and changes nothing.
          </p>
        )}
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <TriangleAlert />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {!state && !error && (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> Reading your orgs…
        </p>
      )}

      {state && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="font-display text-lg">1. Your org</h2>
            </CardTitle>
            <CardDescription>
              Signed in to GitHub as <span className="font-mono">{state.login}</span>. qq needs an org you own.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup value={org} onValueChange={chooseOrg} aria-label="Your org">
              {state.orgs.map((o) => (
                <div key={o.login} className="flex items-start gap-3">
                  <RadioGroupItem
                    value={o.login}
                    id={`org-${o.login}`}
                    disabled={!o.usable}
                    aria-describedby={o.usable ? undefined : `org-${o.login}-why`}
                    className="mt-0.5"
                  />
                  <div className="flex flex-col gap-0.5">
                    <Label htmlFor={`org-${o.login}`} className="font-mono">
                      {o.login}
                    </Label>
                    {/* Outside the label, so the disabled dimming does not fade the only explanation. */}
                    {!o.usable && (
                      <span id={`org-${o.login}-why`} className="text-sm text-muted-foreground">
                        {o.reason}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </RadioGroup>
          </CardContent>
        </Card>
      )}

      {org && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="font-display text-lg">2. Repos to put under qq</h2>
            </CardTitle>
            <CardDescription>
              Setup would open a pull request in each with its qq manifest and generated workflows, then turn
              on the merge queue.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {loadingRepos && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Spinner /> Reading {org}&apos;s repos…
              </p>
            )}
            {list && usableRepos.length === 0 && (
              <p className="text-muted-foreground">No repo in {org} fits a qq kind yet. You can start a new one below.</p>
            )}
            {usableRepos.map((r) => (
              <div key={r.name} className="flex items-start gap-3">
                <Checkbox
                  id={`repo-${r.name}`}
                  checked={picked.has(r.name)}
                  className="mt-0.5"
                  onCheckedChange={(v) => {
                    const next = new Set(picked);
                    if (v === true) next.add(r.name);
                    else next.delete(r.name);
                    setPicked(next);
                  }}
                />
                <Label htmlFor={`repo-${r.name}`} className="flex flex-col items-start gap-1">
                  <span className="font-mono break-all">{r.name}</span>
                  <span className="flex flex-wrap gap-1">
                    {r.kinds.map((k) => (
                      <Badge key={k} variant="outline">
                        {KIND_LABELS[k]}
                      </Badge>
                    ))}
                    {r.onQq && <Badge variant="secondary">has infra/repo.toml</Badge>}
                  </span>
                </Label>
              </div>
            ))}
            {otherRepos.length > 0 && (
              <div className="flex flex-col gap-1 border-t border-border pt-4">
                <p className="text-sm font-medium">Not offered</p>
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {otherRepos.map((r) => (
                    <li key={r.name}>
                      <span className="font-mono break-all text-foreground">{r.name}</span>: {r.reason}
                      {r.notes.length > 0 && <> ({r.notes.join("; ")})</>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {list?.truncated && (
              <p className="text-sm text-muted-foreground">Showing the 100 most recently pushed repos.</p>
            )}
          </CardContent>
        </Card>
      )}

      {org && list && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="font-display text-lg">3. A new repo (optional)</h2>
            </CardTitle>
            <CardDescription>Setup would start a new public repo from a template, already set up for qq.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Checkbox id="starter-on" checked={starterOn} onCheckedChange={(v) => setStarterOn(v === true)} />
              <Label htmlFor="starter-on">Create a starter repo</Label>
            </div>
            {starterOn && (
              <div className="flex flex-col gap-4 sm:flex-row">
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="starter-name">Name</Label>
                  <Input
                    id="starter-name"
                    value={starterName}
                    onChange={(e) => setStarterName(e.target.value.trim())}
                    aria-invalid={!!starterError}
                    aria-describedby={starterError ? "starter-error" : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                  {starterError && (
                    <p id="starter-error" className="text-sm text-destructive">
                      {starterError}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="starter-kind">Template</Label>
                  <NativeSelect
                    id="starter-kind"
                    value={starterKind}
                    onChange={(e) => setStarterKind(e.target.value as StarterKind)}
                  >
                    {(Object.keys(STARTER_LABELS) as StarterKind[]).map((k) => (
                      <NativeSelectOption key={k} value={k}>
                        {STARTER_LABELS[k]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {org && list && (
        <div className="flex flex-col gap-2">
          <Button size="lg" disabled={!canSend} onClick={send} className="w-full sm:w-fit">
            {sending && <Spinner />} Show the plan in my terminal
          </Button>
          <p className="text-sm text-muted-foreground">
            {state?.readOnly
              ? "This version changes nothing on GitHub."
              : "Nothing changes on GitHub until you type yes in the terminal."}
          </p>
        </div>
      )}
    </div>
  );
}
