import { useState } from "react";
import { MousePointer2 } from "lucide-react";
import { toast } from "sonner";

import type { ComputerApproval } from "@pragma-sh/constants";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { answerApproval } from "@/state/computer-use-store";

/**
 * The prompt an agent's first computer-use request (or a sensitive control,
 * like a Delete button) raises. Only this window can answer it: the agent's
 * request waits on the host until the user picks, or until it times out.
 */
export function ComputerApprovalDialog({ approvals }: { approvals: ComputerApproval[] }) {
  const approval = approvals[0] ?? null;
  const [busy, setBusy] = useState(false);

  const answer = async (decision: "once" | "session" | "always" | "deny") => {
    if (!approval) return;
    setBusy(true);
    try {
      await answerApproval(approval, decision);
    } catch (error) {
      toast.error(`Could not answer: ${errorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const sensitive = approval?.sensitive ?? false;
  const target = approval?.target?.appName;

  return (
    <AlertDialog open={approval !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <MousePointer2 />
          </AlertDialogMedia>
          <AlertDialogTitle>{approval?.reason ?? ""}</AlertDialogTitle>
          <AlertDialogDescription>
            {sensitive
              ? "This control can change or send something. Allow just this one action?"
              : `It will be able to read the screen and click and type${
                  target ? ` in ${target}` : ""
                } while you watch. You can stop it at any time from the sidebar or with the stop shortcut.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button disabled={busy} onClick={() => void answer("deny")} variant="outline">
            Deny
          </Button>
          {sensitive ? (
            <Button disabled={busy} onClick={() => void answer("once")}>
              Allow once
            </Button>
          ) : (
            <>
              <Button disabled={busy} onClick={() => void answer("always")} variant="outline">
                Always allow
              </Button>
              <Button disabled={busy} onClick={() => void answer("session")}>
                Allow for this session
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
