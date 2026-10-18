// The form's side of the local API that cli/server.mjs serves. The page trades the single-use key
// from the link's fragment (which browsers never send anywhere) for an HttpOnly session cookie and a
// token. The token lives in this tab's sessionStorage (scoped to this port, unlike cookies) and goes
// in the x-qq-setup header of every later call, with the cookie.

export type Kind = "python-service" | "pytest" | "node-app" | "gatsby-site";

export type Org = { login: string; role: string; usable: boolean; reason?: string };

export type Repo = {
  name: string;
  visibility: string;
  archived: boolean;
  fork: boolean;
  defaultBranch: string;
  kinds: Kind[];
  onQq: boolean;
  usable: boolean;
  reason?: string;
  notes: string[];
};

export type State = {
  version: string;
  readOnly: boolean;
  login: string;
  orgs: Org[];
  // Why the GitHub parts are off (no gh, no login, missing scopes), or null when they work.
  github: string | null;
  platform: string;
};

// The "This machine" panel (cli/machine.mjs). The page sends only a choice per tool and a plan's id.
export type Action = "install" | "update" | "remove" | "keep" | "path";
export type MachineTool = { line: string; choices: Action[]; installed: boolean; broken: boolean };
export type Machine = {
  platform: string;
  pin: string;
  running: boolean;
  // The signature of this look: a plan is made only while the machine still matches it.
  seen: string;
  demo: string[];
  qq: MachineTool & { localWork: string | null; pythonLine: { line: string; files: string[] } | null };
  xo: MachineTool & { foreign: boolean; note: string | null };
};
export type Choice = { qq: Action; xo: Action; demo: string[]; python: boolean };
export type Step = { what: string; cmd: string };
export type Plan = { ok: true; id: string | null; steps: Step[]; stop: string | null; notes: string[] };
export type StepStatus = { what: string; status: "pending" | "running" | "ok" | "failed"; code?: number };
export type Progress = {
  running: boolean;
  run: null | { id: string; steps: StepStatus[]; log: string; next: number; done: boolean; code: number | null; notes: string[] };
};
export type RepoList = { org: string; truncated: boolean; repos: Repo[] };
export type StarterKind = "node-app" | "python-service";
export type Answers = { org: string; repos: string[]; starter: null | { name: string; kind: StarterKind } };
export type DoneAnswer = { mode: "done" };

export const KIND_LABELS: Record<Kind, string> = {
  "python-service": "Python service",
  pytest: "pytest",
  "node-app": "Next.js app",
  "gatsby-site": "Gatsby site",
};

export const STARTER_LABELS: Record<StarterKind, string> = {
  "node-app": "Next.js 16 app (pnpm, Node 24)",
  "python-service": "Python 3.14 service with pytest",
};

export function keyFromHash(hash: string): string | null {
  const m = /(?:^#|&)key=([A-Za-z0-9_-]{16,})/.exec(hash);
  return m ? m[1] : null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // The machine no longer matches what the page shows: look again.
    readonly changed = false,
    // A newer plan request than this one reached qq-setup first.
    readonly superseded = false,
  ) {
    super(message);
  }
}

const TOKEN = "qq-setup-token";

function readToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN);
  } catch {
    return null;
  }
}

export function hasToken(): boolean {
  return readToken() !== null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "x-qq-setup": readToken() ?? "1", ...(init?.headers ?? {}) },
    credentials: "same-origin",
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // fall through to the status line
  }
  const error = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : null;
  if (!res.ok || error) {
    const flag = (k: string) => !!body && typeof body === "object" && k in body && (body as Record<string, unknown>)[k] === true;
    throw new ApiError(error ?? `qq-setup answered ${res.status}. Is it still running in your terminal?`, res.status, flag("changed"), flag("superseded"));
  }
  return body as T;
}

export const api = {
  /** Trade the link's key; resolves true once the tab holds the token (the cookie is the browser's). */
  session: async (key: string) => {
    const r = await call<{ ok: true; token: string }>("/api/session", {
      method: "POST",
      headers: { "x-qq-setup-key": key, "x-qq-setup": "1" },
    });
    try {
      window.sessionStorage.setItem(TOKEN, r.token);
    } catch {
      throw new ApiError("Your browser would not let this page keep its sign-in for this tab (sessionStorage): allow site data for 127.0.0.1 and run the command again.", 0);
    }
    return true;
  },
  state: () => call<State>("/api/state"),
  repos: (org: string) => call<RepoList>(`/api/repos?org=${encodeURIComponent(org)}`),
  machine: () => call<Machine>("/api/machine"),
  plan: (choice: Choice, seen: string) =>
    call<Plan>("/api/machine/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...choice, seen }),
    }),
  run: (id: string) =>
    call<{ ok: true; id: string }>("/api/machine/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  progress: (from: number) => call<Progress>(`/api/machine/run?from=${from}`),
  submit: (answers: Answers | DoneAnswer) =>
    call<{ ok: true }>("/api/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answers),
    }),
};
