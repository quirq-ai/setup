"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { AboutOrgSetup, AboutTogether } from "@/components/about";
import { MachinePanel } from "@/components/machine-panel";
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
  ApiError,
  keyFromHash,
  KIND_LABELS,
  STARTER_LABELS,
  type RepoList,
  type StarterKind,
  type Machine,
  type State,
} from "@/lib/api";
import { isName } from "@/cli/names.mjs";

// What closed the form: the "This machine" Done button, or the org answers.
type Mode = "machine" | "repos";

// "pending" while prerendering and until the server answers; "none" when this tab holds neither
// the link's unused key nor the session it was traded for.
type Session = "pending" | "ready" | "none";

// What happened to the link's key: traded by this tab, refused (already used), or there was none.
type Opened = "traded" | "refused" | "nokey";

// Started once per page load, outside React, so a re-run effect never races its own key trade.
let opened: Promise<Opened> | null = null;
function openSession(): Promise<Opened> {
  if (!opened) {
    // The key lives in the fragment of the link the terminal printed. Trade it once, and drop it from
    // the address bar and history. A reload has no key but keeps this tab's session.
    const key = keyFromHash(window.location.hash);
    if (key) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    opened = key
      ? api.session(key).then(
          (): Opened => "traded",
          (e: unknown): Opened | Promise<never> => (e instanceof ApiError && e.status === 403 ? "refused" : Promise.reject(e)),
        )
      : Promise.resolve<Opened>("nokey");
  }
  return opened;
}

const NO_COOKIE =
  "Your browser did not keep qq-setup's cookie, so this page cannot go on. Allow cookies for 127.0.0.1 and run the command again.";

export function SetupForm() {
  const [session, setSession] = useState<Session>("pending");
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
  // Whether qq is on this machine, from the "This machine" panel's latest look (null until the first).
  const [hasQq, setHasQq] = useState<boolean | null>(null);
  const latestOrg = useRef("");
  const machineRef = useRef<HTMLElement>(null);
  const reposRef = useRef<HTMLElement>(null);

  const chooseOrg = useCallback(
    (login: string) => {
      latestOrg.current = login;
      setOrg(login);
      setList(null);
      setPicked(new Set());
      setError(null);
      setLoadingRepos(true);
      api
        .repos(login)
        .then(
          (l) => latestOrg.current === login && setList(l),
          (e: Error) => latestOrg.current === login && setError(e.message),
        )
        .finally(() => latestOrg.current === login && setLoadingRepos(false));
    },
    [],
  );

  // qq first: when the first look finds no qq, take the reader to the install step.
  const looked = useCallback((m: Machine) => {
    // A broken install counts as there: its panel offers Reinstall, with its own line.
    const here = m.qq.installed || m.qq.broken;
    setHasQq((was) => {
      if (was === null && !here) machineRef.current?.scrollIntoView({ block: "start" });
      return here;
    });
  }, []);

  useEffect(() => {
    let live = true;
    openSession()
      .then((how) =>
        api.state().catch((e: unknown) => {
          // The trade worked, yet the cookie did not come back: the browser refused to store it.
          if (how === "traded" && e instanceof ApiError && e.status === 401) throw new Error(NO_COOKIE);
          throw e;
        }),
      )
      .then(
        (s) => {
          if (!live) return;
          setState(s);
          setSession("ready");
          const usable = s.orgs.filter((o) => o.usable);
          if (usable.length === 1) chooseOrg(usable[0].login);
        },
        (e: Error) => {
          if (!live) return;
          if (e instanceof ApiError && e.status === 401) setSession("none");
          else setError(e.message);
        },
      );
    return () => {
      live = false;
    };
  }, [chooseOrg]);

  if (session === "pending" && !error) return null;
  if (session === "none") {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>Open this page from your terminal</AlertTitle>
        <AlertDescription>
          Run <code className="font-mono break-all">npx --allow-remote=root https://codeload.github.com/quirq-ai/setup/tar.gz/&lt;commit&gt;</code> and
          use the link it prints. Each link works in one tab only. If it was already opened, go back to that
          tab, or run the command again for a new link. If you did not open it anywhere else, stop the command
          with Ctrl-C.
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
            {done === "machine"
              ? "qq-setup has stopped. You can close this tab."
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
    setSending(true);
    setError(null);
    try {
      await api.submit({
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

  const usableRepos = list?.repos.filter((r) => r.usable) ?? [];
  const ownsAnOrg = !!state?.orgs.some((o) => o.usable);
  const otherRepos = list?.repos.filter((r) => !r.usable) ?? [];

  const go = (to: React.RefObject<HTMLElement | null>) => to.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-2xl">Set up qq</h1>
        <p className="text-muted-foreground">
          First install qq on this machine (and xo, if you want it), then put your org&apos;s repos under qq.
        </p>
        <AboutTogether />
        {state?.readOnly && (
          <p className="text-sm text-muted-foreground">
            It changes nothing on GitHub. On this machine it runs only the steps you pick, after you press Run.
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
          <Spinner /> Loading…
        </p>
      )}

      {state && (
        <nav
          aria-label="Steps"
          className="sticky top-0 z-10 -mx-4 flex flex-wrap gap-2 border-b border-border bg-background px-4 py-2 md:-mx-8 md:px-8"
        >
          <Button variant="outline" size="sm" onClick={() => go(machineRef)}>
            1. This machine
          </Button>
          <Button variant="outline" size="sm" onClick={() => go(reposRef)}>
            2. Your org&apos;s repos
          </Button>
        </nav>
      )}

      {state && (
        <section ref={machineRef} aria-labelledby="step-machine" className="flex scroll-mt-24 flex-col gap-6">
          <h2 id="step-machine" className="font-display text-xl">
            1. Install, update or remove qq and xo on this machine
          </h2>
          {hasQq === false && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Start here: qq is not on this machine</AlertTitle>
              <AlertDescription>Pick Install for qq below, then press Run.</AlertDescription>
            </Alert>
          )}
          <MachinePanel onLook={looked} held={sending} onDone={() => setDone("machine")} />
        </section>
      )}

      {state && (
        <section ref={reposRef} aria-labelledby="step-repos" className="flex scroll-mt-24 flex-col gap-6">
          <h2 id="step-repos" className="font-display text-xl">
            2. Set up repos in an org you own
          </h2>
          <AboutOrgSetup />
          {hasQq === false && (
            <p className="text-sm text-muted-foreground">qq is not on this machine yet: install it in step 1 first.</p>
          )}
          {state.github ? (
            <p className="text-muted-foreground">
              Needs GitHub, which is not ready: {state.github}. Fix it, then run qq-setup again.
            </p>
          ) : !ownsAnOrg ? (
            <p className="text-muted-foreground">
              You own no GitHub org yet: create a free one at github.com/account/organizations/new, then run qq-setup again.
            </p>
          ) : (
            <>
            <Card>
              <CardHeader>
                <CardTitle>
                  <h3 className="font-display text-lg">Your org</h3>
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

            {org && (
              <Card>
                <CardHeader>
                  <CardTitle>
                    <h3 className="font-display text-lg">Repos to put under qq</h3>
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
                    <h3 className="font-display text-lg">A new repo (optional)</h3>
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
            </>
          )}
        </section>
      )}
    </div>
  );
}
