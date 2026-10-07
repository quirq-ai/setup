// The form's side of the local API that cli/server.mjs serves. Every call carries the one-time key
// from the link the terminal printed (kept in the URL fragment, which browsers never send anywhere).

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

export type State = { version: string; readOnly: boolean; login: string; orgs: Org[] };
export type RepoList = { org: string; truncated: boolean; repos: Repo[] };
export type StarterKind = "node-app" | "python-service";
export type Answers = { org: string; repos: string[]; starter: null | { name: string; kind: StarterKind } };

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

async function call<T>(key: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...(init?.headers ?? {}), "x-qq-setup-key": key },
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
    throw new Error(error ?? `qq-setup answered ${res.status}. Is it still running in your terminal?`);
  }
  return body as T;
}

export const api = {
  state: (key: string) => call<State>(key, "/api/state"),
  repos: (key: string, org: string) => call<RepoList>(key, `/api/repos?org=${encodeURIComponent(org)}`),
  submit: (key: string, answers: Answers) =>
    call<{ ok: true }>(key, "/api/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answers),
    }),
};
