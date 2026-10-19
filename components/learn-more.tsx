"use client";

import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

/** A quiet "learn more" line: closed by default, opens in place (never a popup), so the page stays short until asked. */
export function LearnMore({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Collapsible className="group/learn flex flex-col gap-2">
      <CollapsibleTrigger className="flex w-fit items-center gap-1 rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]/learn:rotate-90" aria-hidden />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 border-l-2 border-border pl-4 text-sm">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** A link out to the guide that says more, so the page never restates it. */
export function GuideLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="w-fit font-medium text-primary underline underline-offset-4">
      {children}
    </a>
  );
}
