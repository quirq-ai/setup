"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, CircleDashed, CircleX, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Command } from "@/components/command";
import { api, type ApiError, type Action, type Choice, type Machine, type MachineTool, type Plan, type Progress } from "@/lib/api";

type Tool = "qq" | "xo";
type Run = NonNullable<Progress["run"]>;

const NAMES: Record<Tool, string> = { qq: "qq (with qqsync)", xo: "xo" };

function label(a: Action, t: MachineTool): string {
  if (a === "install") return t.broken ? "Reinstall" : "Install";
  if (a === "update") return "Update";
  if (a === "path") return "Add to PATH";
  if (a === "remove") return "Remove";
  return t.installed || t.broken ? "Keep" : "Don't install";
}

/** The page's half of cli/machine.mjs: pick per tool, see the exact steps, press Run, watch them. */
export function MachinePanel({ onDone }: { onDone: () => void }) {
  const [m, setM] = useState<Machine | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  // The plan, with the choice it was made for: a plan for an older choice is never shown or run.
  const [planned, setPlanned] = useState<{ key: string; plan: Plan } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Why the last Run was refused or failed to start; kept while the page looks at the machine again.
  const [runError, setRunError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [starting, setStarting] = useState(false);
  const [closing, setClosing] = useState(false);
  const planFor = useRef("");
  // The signature of the look on screen: the terminal plans only while the machine still matches it.
  const seen = useRef("");
  const reload = useRef<() => Promise<void>>(async () => {});

  // Every change of choice asks the terminal for the steps it would run; only the latest answer counts.
  const choose = useCallback((next: Choice) => {
    const key = JSON.stringify(next);
    planFor.current = key;
    setChoice(next);
    setRunError(null);
    const ask = (): void => void api.plan(next, seen.current).then(
      (p) => planFor.current === key && (setPlanned({ key, plan: p }), setError(null)),
      (e: ApiError) => {
        if (planFor.current !== key) return;
        // An older request for another choice reached qq-setup after this one: ask again.
        if (e.superseded) return ask();
        if (!e.changed) return setError(e.message);
        // Something changed on the machine (new local work, say): show what is there now, so every
        // warning comes from it, and start again from Keep.
        void reload.current().then(() => setRunError(`${e.message}. Pick again.`));
      },
    );
    ask();
  }, []);

  // A fresh look at the machine. Every tool starts at Keep: nothing is installed or removed until picked.
  const show = useCallback(
    (s: Machine) => {
      setM(s);
      seen.current = s.seen;
      choose({ qq: "keep", xo: "keep", demo: [], python: false });
    },
    [choose],
  );
  const load = useCallback(() => api.machine().then(show), [show]);
  useEffect(() => {
    reload.current = load;
  }, [load]);

  useEffect(() => {
    let live = true;
    api.machine().then(
      (s) => live && show(s),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [show]);

  async function start() {
    if (!plan?.id) return;
    setStarting(true);
    setRunError(null);
    try {
      await api.run(plan.id);
      let from = 0;
      let log = "";
      for (;;) {
        const p = await api.progress(from);
        if (!p.run) break;
        log += p.run.log;
        from = p.run.next;
        setRun({ ...p.run, log });
        if (p.run.done) break;
        await new Promise((ok) => setTimeout(ok, 600));
      }
      await load();
    } catch (e) {
      setRunError((e as Error).message);
      // A refused run (the machine changed) needs a fresh look and a fresh plan.
      await load().catch(() => {});
    } finally {
      setStarting(false);
    }
  }

  async function close() {
    setClosing(true);
    try {
      await api.submit({ mode: "done" });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setClosing(false);
    }
  }

  if (!m || !choice) {
    return error ? (
      <Alert variant="destructive" role="alert">
        <TriangleAlert />
        <AlertTitle>Could not look at this machine</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    ) : (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Spinner /> Looking at what is installed…
      </p>
    );
  }

  const running = starting || m.running;
  const losesWork = !!m.qq.localWork && ["install", "update", "remove"].includes(choice.qq);
  const plan = planned && planned.key === JSON.stringify(choice) ? planned.plan : null;
  const steps = plan?.steps ?? [];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-display text-lg">1. What to do on this machine</h2>
          </CardTitle>
          <CardDescription>
            Each tool starts at Keep. Nothing is installed or removed unless you pick it, and nothing runs until you press Run.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {(["qq", "xo"] as const).map((tool) => {
            const t = m[tool];
            return (
              <fieldset key={tool} className="flex flex-col gap-3" disabled={running}>
                <legend className="font-medium">{NAMES[tool]}</legend>
                <p className="text-sm text-muted-foreground break-words">{t.line}</p>
                {tool === "xo" && m.xo.note && <p className="text-sm text-muted-foreground">{m.xo.note}.</p>}
                {tool === "qq" && m.qq.localWork && (
                  <p className="text-sm text-muted-foreground">
                    ~/qq-tools/depot has {m.qq.localWork}. Keep leaves it as it is.
                  </p>
                )}
                {t.choices.length > 0 ? (
                  <RadioGroup
                    value={choice[tool]}
                    onValueChange={(v) =>
                      choose({ ...choice, [tool]: v as Action, ...(tool === "qq" && v !== "remove" ? { demo: [], python: false } : {}) })
                    }
                    aria-label={`What to do with ${tool}`}
                    className="flex flex-wrap gap-x-6 gap-y-2"
                  >
                    {t.choices.map((a) => (
                      <div key={a} className="flex items-center gap-2">
                        <RadioGroupItem value={a} id={`${tool}-${a}`} />
                        <Label htmlFor={`${tool}-${a}`}>{label(a, t)}</Label>
                      </div>
                    ))}
                  </RadioGroup>
                ) : (
                  <p className="text-sm">Move ~/.xo away to install xo here; qq-setup leaves it alone.</p>
                )}
              </fieldset>
            );
          })}

          {choice.qq === "remove" && m.qq.pythonLine && (
            <fieldset className="flex flex-col gap-2" disabled={running}>
              <legend className="font-medium">qq&apos;s Python setting</legend>
              <p className="text-sm text-muted-foreground">Something else may use that Python. The line stays unless you tick it.</p>
              <div className="flex items-center gap-3">
                <Checkbox
                  id="python-line"
                  checked={choice.python}
                  onCheckedChange={(v) => choose({ ...choice, python: v === true })}
                />
                <Label htmlFor="python-line" className="block leading-snug">
                  Also delete <code className="font-mono">{m.qq.pythonLine.line}</code> from{" "}
                  {m.qq.pythonLine.files.map((f) => `~/${f}`).join(", ")}
                </Label>
              </div>
            </fieldset>
          )}

          {choice.qq === "remove" && m.demo.length > 0 && (
            <fieldset className="flex flex-col gap-2" disabled={running}>
              <legend className="font-medium">The qq guide&apos;s demo folders</legend>
              <p className="text-sm text-muted-foreground">Your own clones may be in them. They stay unless you tick them.</p>
              {m.demo.map((d) => (
                <div key={d} className="flex items-center gap-3">
                  <Checkbox
                    id={`demo-${d}`}
                    checked={choice.demo.includes(d)}
                    onCheckedChange={(v) =>
                      choose({ ...choice, demo: v === true ? [...choice.demo, d] : choice.demo.filter((x) => x !== d) })
                    }
                  />
                  <Label htmlFor={`demo-${d}`} className="font-mono">
                    Also delete ~/{d}
                  </Label>
                </div>
              ))}
            </fieldset>
          )}

          {losesWork && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>This deletes your local work in qq</AlertTitle>
              <AlertDescription>
                {choice.qq === "remove" ? "Removing" : "Reinstalling"} qq deletes ~/qq-tools/depot, which has {m.qq.localWork}.
                Pick Keep to leave it.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="font-display text-lg">2. The commands</h2>
          </CardTitle>
          <CardDescription>Exactly what Run runs, in order, in your home folder. Each is safe to run again.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!plan && !error && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner /> Working out the steps…
            </p>
          )}
          {plan?.stop && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Cannot run this yet</AlertTitle>
              <AlertDescription>{plan.stop}</AlertDescription>
            </Alert>
          )}
          {plan && !plan.stop && steps.length === 0 && <p className="text-muted-foreground">Nothing to do with these choices.</p>}
          {steps.map((s, i) => (
            <div key={`${i}-${s.cmd}`} className="flex flex-col gap-2">
              <p className="text-sm">
                {i + 1}. {s.what}
              </p>
              <Command label={s.what.replace(/ \(.*$/, "")}>{s.cmd}</Command>
            </div>
          ))}
          {plan?.notes.map((n) => (
            <p key={n} className="text-sm text-muted-foreground">
              {n}
            </p>
          ))}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          disabled={running || !plan?.id || steps.length === 0}
          onClick={start}
          className="w-full sm:w-fit"
        >
          {running && <Spinner />} {steps.length === 1 ? "Run this step" : steps.length ? `Run these ${steps.length} steps` : "Run"}
        </Button>
        {[runError, error].filter(Boolean).map((e) => (
          <p key={e} role="alert" className="text-sm text-destructive">
            {e}
          </p>
        ))}
        <p className="text-sm text-muted-foreground">
          They run on this machine, as you, and their output shows below and in your terminal.
        </p>
      </div>

      {run && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="font-display text-lg">
                {!run.done ? "Running…" : run.code === 0 ? "Done" : "Stopped at a failed step"}
              </h2>
            </CardTitle>
            {run.done && (
              <CardDescription>
                {run.code === 0
                  ? "Open a new terminal so PATH changes take effect."
                  : "Fix what the output says, then press Run again: every step is safe to run again."}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ol className="flex flex-col gap-1 text-sm">
              {run.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2">
                  {s.status === "ok" ? (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--state-green)]" aria-hidden />
                  ) : s.status === "failed" ? (
                    <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                  ) : s.status === "running" ? (
                    <Spinner className="mt-0.5 shrink-0" />
                  ) : (
                    <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span>
                    {i + 1}. {s.what}
                    <span className="text-muted-foreground">
                      {" "}
                      ({s.status === "ok" ? "done" : s.status === "failed" ? `failed, exit ${s.code}` : s.status === "running" ? "running" : "not run"})
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <pre
              tabIndex={0}
              aria-label="Output"
              className="max-h-96 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all focus-visible:outline-hidden focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {run.log.trimStart()}
            </pre>
            {run.notes.map((n) => (
              <p key={n} className="text-sm">
                {n}
              </p>
            ))}
            {run.done && (
              <Button variant="outline" disabled={closing} onClick={close} className="w-full sm:w-fit">
                {closing && <Spinner />} Done: close qq-setup
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
