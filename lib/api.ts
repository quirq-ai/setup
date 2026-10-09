// The form's side of the local API that cli/server.mjs serves. The page trades the single-use key
// from the link's fragment (which browsers never send anywhere) for an HttpOnly session cookie, then
// every call carries that cookie and the x-qq-setup header.

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

export type Tools = {
  install: { what: string; cmd: string }[];
  use: { cmd: string; what: string }[];
  useNote: string;
  needs: string;
  mac: string;
  access: string;
};
export type State = { version: string; readOnly: boolean; login: string; orgs: Org[]; platform: string; tools: Tools };
export type RepoList = { org: string; truncated: boolean; repos: Repo[] };
export type StarterKind = "node-app" | "python-service";
export type Answers = { org: string; repos: string[]; starter: null | { name: string; kind: StarterKind } };
export type ToolsAnswer = { mode: "tools"; repo: string | null };

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
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), "x-qq-setup": "1" },
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
    throw new ApiError(error ?? `qq-setup answered ${res.status}. Is it still running in your terminal?`, res.status);
  }
  return body as T;
}

export const api = {
  session: (key: string) => call<{ ok: true }>("/api/session", { method: "POST", headers: { "x-qq-setup-key": key } }),
  state: () => call<State>("/api/state"),
  repos: (org: string) => call<RepoList>(`/api/repos?org=${encodeURIComponent(org)}`),
  submit: (answers: Answers | ToolsAnswer) =>
    call<{ ok: true }>("/api/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answers),
    }),
};
