import { GuideLink, LearnMore } from "@/components/learn-more";

// What qq and xo are, in the words of their own guides (docs.quirq.dev "What is qq", the xo README and
// quickstart). Each says a line and links out; the guides stay the place to read more.

export function AboutQq() {
  return (
    <LearnMore title="What is qq?">
      <p>
        qq is quirq&apos;s build and release infrastructure, and <code className="font-mono">qq</code> is its command line.
        You write code the way you always do, by hand or with an agent. qq then:
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        <li>builds and tests it the same way on your laptop and on GitHub;</li>
        <li>decides whether it may land, and keeps <code className="font-mono">main</code> green;</li>
        <li>moves tested commits out to a release channel.</li>
      </ul>
      <p className="text-muted-foreground">
        qqsync, installed with it, reads each repo&apos;s manifest, <code className="font-mono">infra/repo.toml</code>, which pins
        its toolchains.
      </p>
      <GuideLink href="https://docs.quirq.dev/docs">What is qq: the guide and a 3-minute video</GuideLink>
    </LearnMore>
  );
}

export function AboutXo() {
  return (
    <LearnMore title="What is xo?">
      <p>
        xo is the command line for the XO Cloud API. Every endpoint is a command, and xo sends your XO API key on each request
        without ever printing it.
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        <li>
          <code className="font-mono">xo login</code> saves your XO API key, which the XO team gives you;
        </li>
        <li>
          <code className="font-mono">xo create space NAME KIND</code> creates a space on XO Cloud, such as a Claude Code or
          Codex space;
        </li>
        <li>
          <code className="font-mono">xo status</code> shows where you are logged in.
        </li>
      </ul>
      <GuideLink href="https://github.com/quirq-ai/xo/blob/main/docs/quickstart.md">The xo quickstart</GuideLink>
    </LearnMore>
  );
}

export function AboutOrgSetup() {
  return (
    <LearnMore title="What does setting up repos do?">
      <p>For the org you pick, setup would:</p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        <li>
          create a config repo, <code className="font-mono">qq-config</code>;
        </li>
        <li>open a pull request in each repo with its qq manifest and generated workflows;</li>
        <li>turn on the merge queue, so every change is tested as it will land.</li>
      </ul>
      <p className="text-muted-foreground">Today it only shows that plan in your terminal: it changes nothing on GitHub.</p>
      <GuideLink href="https://docs.quirq.dev/docs/add-a-repo">Add a repo to qq</GuideLink>
    </LearnMore>
  );
}

export function AboutTogether() {
  return (
    <LearnMore title="How qq and xo fit together">
      <p>
        xo creates the spaces on XO Cloud where agents work. qq is how the code they write is built, tested, landed and shipped.
        You can use either without the other.
      </p>
    </LearnMore>
  );
}
