"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function Command({ children, label }: { children: string; label: string }) {
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
