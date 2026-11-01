"use client";

import { KeyboardShortcutProvider, TooltipProvider } from "@dub/ui";
import PlausibleProvider from "next-plausible";
import { ReactNode } from "react";
import { Toaster } from "sonner";

// Analytics is opt-in for self-hosted deployments: set
// NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL to your Plausible site script URL
// (e.g. https://plausible.io/js/pa-XXXXX.js) to enable the local proxy.
const plausibleScriptUrl = process.env.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL || "";

export default function RootProviders({ children }: { children: ReactNode }) {
  const content = (
    <KeyboardShortcutProvider>
      <Toaster className="pointer-events-auto" position="bottom-center" />
      {children}
    </KeyboardShortcutProvider>
  );

  return (
    <TooltipProvider>
      {plausibleScriptUrl ? (
        <PlausibleProvider enabled src="/_proxy/plausible/script.js">
          {content}
        </PlausibleProvider>
      ) : (
        content
      )}
    </TooltipProvider>
  );
}
