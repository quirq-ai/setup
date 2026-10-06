# Agent guide

Read README.md first. Rules for changing this repo:

1. **Writes need review first.** Anything that creates, changes or deletes something on GitHub, or
   changes which credentials or scopes the command uses, goes to the coordinator's audit before it is
   built on. Writes to a real user's org, npm publishing, GitHub/OAuth App creation and DNS are
   suraj's call.
2. **Only the user's own gh login.** Never read the token into this process, never pass one through
   the environment, never send one to the form page.
3. **One generator.** Workflows and config come from quirq-ai/infra-config's `qqcfg`; never write a
   second generator here.
4. **The form is shadcn on Next.js 16**, a static export served by `cli/server.mjs`. Popups never
   scroll; detail belongs on the page.
5. **Copy must not claim what v0 does not do.** Say "prints" for what the command only tells the user.
6. Before pushing: `npm run lint && npm run typecheck && npm test && npm run build && npm run e2e`.
