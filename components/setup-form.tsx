"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, CircleCheck, Copy, TriangleAlert } from "lucide-react";
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
  type Tools,
} from "@/lib/api";
import { isBlankRepo, isName, parseRepo } from "@/cli/names.mjs";

type Mode = "repos" | "tools";

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
  const [done, setDone] = useState<Mode | null>(null);
  const [mode, setMode] = useState<Mode>("repos");
  const [workRepo, setWorkRepo] = useState("");
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
        if (usable.length === 0) setMode("tools");
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
          Run <code className="font-mono break-all">npx --allow-remote=root https://codeload.github.com/quirq-ai/setup/tar.gz/&lt;commit&gt;</code> and
          use the link it prints.
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
            {done === "tools"
              ? "qq-setup printed the commands there. You can close this tab."
              : "qq-setup has your answers and shows the plan there. You can close this tab."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const starterError =
    starterOn && starterName && !isName(starterName)
      ? "Letters, digits, '.', '_' and '-' only, starting with a letter or digit and not ending in .git."
      : starterOn && list?.repos.some((r) => r.name.toLowerCase() === starterName.toLowerCase())
        ? `${org} already has a repo with this name.`
        : null;
  const why = !org
    ? "Pick an org to continue."
    : starterError
      ? "Fix the starter repo name to continue."
      : picked.size === 0 && !(starterOn && starterName)
        ? "Pick a repo or name a starter repo to continue."
        : null;
  const canSend = !sending && !why;

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
      setDone("repos");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  // The same check the terminal runs (cli/names.mjs). Only spaces count as blank; anything else
  // (".git", a bare github.com link, a tab) must name a repo.
  const repoForTools = isBlankRepo(workRepo) ? null : parseRepo(workRepo);
  const workRepoError =
    !isBlankRepo(workRepo) && !repoForTools ? "Write it as owner/name, like quirq-ai/innernet." : null;

  async function sendTools() {
    if (!key) return;
    setSending(true);
    setError(null);
    try {
      await api.submit(key, { mode: "tools", repo: repoForTools });
      setDone("tools");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const usableRepos = list?.repos.filter((r) => r.usable) ?? [];
  const ownsAnOrg = !!state?.orgs.some((o) => o.usable);
  const otherRepos = list?.repos.filter((r) => !r.usable) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-2xl">Set up qq</h1>
        <p className="text-muted-foreground">
          Put your org&apos;s repos under qq, or install qq on this machine to work on a repo that already uses
          it. Your answer goes back to the terminal.
        </p>
        {state?.readOnly && (
          <p className="text-sm text-muted-foreground">
            This version only shows the plan or prints commands. It creates, changes and installs nothing.
          </p>
        )}
      </div>

      {error && !(state && mode === "tools") && (
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
              <h2 className="font-display text-lg">What do you want to do?</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup value={mode} onValueChange={(v) => setMode(v as Mode)} aria-label="What do you want to do?">
              <div className="flex items-start gap-3">
                <RadioGroupItem
                  value="repos"
                  id="mode-repos"
                  disabled={!ownsAnOrg}
                  className="mt-0.5"
                  aria-describedby="mode-repos-what"
                />
                <div className="flex flex-col gap-0.5">
                  {/* Only the label dims: the line under it is the explanation. */}
                  <Label htmlFor="mode-repos" className={ownsAnOrg ? undefined : "opacity-50"}>
                    Set up repos in an org I own
                  </Label>
                  <span id="mode-repos-what" className="text-sm text-muted-foreground">
                    {ownsAnOrg
                      ? "Pick the org and repos. The terminal shows the plan."
                      : "You own no GitHub org yet: create a free one at github.com/account/organizations/new, then run qq-setup again."}
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <RadioGroupItem value="tools" id="mode-tools" className="mt-0.5" aria-describedby="mode-tools-what" />
                <div className="flex flex-col gap-0.5">
                  <Label htmlFor="mode-tools">Install qq on my machine and work on a repo</Label>
                  <span id="mode-tools-what" className="text-sm text-muted-foreground">
                    For a repo that already uses qq. The terminal prints the commands.
                  </span>
                </div>
              </div>
            </RadioGroup>
          </CardContent>
        </Card>
      )}

      {state && mode === "tools" && (
        <ToolsSteps
          tools={state.tools}
          mac={state.platform === "darwin"}
          error={error}
          repo={workRepo}
          okRepo={repoForTools}
          repoError={workRepoError}
          onRepo={setWorkRepo}
          sending={sending}
          onSend={sendTools}
        />
      )}

      {state && mode === "repos" && (
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

      {mode === "repos" && org && (
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

      {mode === "repos" && org && list && (
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

      {mode === "repos" && org && list && (
        <div className="flex flex-col gap-2">
          <Button
            size="lg"
            disabled={!canSend}
            onClick={send}
            aria-describedby={why ? "send-why" : undefined}
            className="w-full sm:w-fit"
          >
            {sending && <Spinner />} Show the plan in my terminal
          </Button>
          {why && (
            <p id="send-why" className="text-sm text-muted-foreground">
              {why}
            </p>
          )}
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

function Command({ children, label }: { children: string; label: string }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        {/* One line that scrolls inside the block: wrapping would split words at hyphens (~/qq-|tools). */}
        <pre
          tabIndex={0}
          className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm whitespace-pre focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {children}
        </pre>
        <Button
          variant="outline"
          size="icon"
          aria-label={copied === "yes" ? `Copied: ${label}` : `Copy: ${label}`}
          onClick={() => {
            navigator.clipboard.writeText(children).then(
              () => {
                setCopied("yes");
                setTimeout(() => setCopied(null), 2000);
              },
              () => setCopied("failed"),
            );
          }}
        >
          {copied === "yes" ? <Check aria-hidden /> : <Copy aria-hidden />}
        </Button>
      </div>
      {copied === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          Could not copy. Select the command and copy it yourself.
        </p>
      )}
    </div>
  );
}

function ToolsSteps(props: {
  tools: Tools;
  mac: boolean;
  error: string | null;
  repo: string;
  okRepo: string | null;
  repoError: string | null;
  onRepo: (v: string) => void;
  sending: boolean;
  onSend: () => void;
}) {
  const { tools, mac, repoError } = props;
  const url = `https://github.com/${props.okRepo ?? "OWNER/NAME"}`;
  const getRepoLine = mac ? `git clone ${url}` : `qq fetch ${url}`;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-display text-lg">1. Install qq on this machine</h2>
          </CardTitle>
          <CardDescription>Run each command once. Each is safe to run again.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Each command is one line: scroll it sideways, or use its copy button.
          </p>
          {tools.install.map((s) => (
            <div key={s.what} className="flex flex-col gap-2">
              <p className="text-sm">{s.what}</p>
              <Command label={s.what.replace(/ \(.*$/, "")}>{s.cmd}</Command>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">Needs {tools.needs}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-display text-lg">2. Get the repo and work in it</h2>
          </CardTitle>
          <CardDescription>The repo must have infra/repo.toml.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="work-repo">Repo (optional)</Label>
            <Input
              id="work-repo"
              value={props.repo}
              placeholder="owner/name"
              onChange={(e) => props.onRepo(e.target.value)}
              aria-invalid={!!repoError}
              aria-describedby={repoError ? "work-repo-error" : undefined}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            {repoError && (
              <p id="work-repo-error" className="text-sm text-destructive">
                {repoError}
              </p>
            )}
          </div>
          <Command label={mac ? "Clone the repo" : "Get the repo"}>{getRepoLine}</Command>
          {mac && <p className="text-sm text-muted-foreground">{tools.mac}</p>}
          <ul className="flex flex-col gap-1 text-sm">
            {tools.use.map((u) => (
              <li key={u.cmd}>
                <code className="font-mono">{u.cmd}</code>
                <span className="text-muted-foreground">: {u.what}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">{tools.useNote}</p>
          <p className="text-sm text-muted-foreground">{tools.access}</p>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          disabled={props.sending || !!repoError}
          onClick={props.onSend}
          aria-describedby={repoError ? "work-repo-error" : undefined}
          className="w-full sm:w-fit"
        >
          {props.sending && <Spinner />} Print these in my terminal
        </Button>
        {props.error && (
          <p role="alert" className="text-sm text-destructive">
            {props.error}
          </p>
        )}
        <p className="text-sm text-muted-foreground">qq-setup prints the commands. It runs none of them.</p>
      </div>
    </>
  );
}
