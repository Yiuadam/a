"use client";

import billingBlocker from "../state";
import UsageMeter from "@/components/billing/UsageMeter";
import { HubScreen } from "@/components/HubMenu";
import { useTier } from "@/lib/billing/useTier";

/*
  One subject: how much of each allowance is gone.

  This is the screen most people came to /billing for, and on the stacked page
  it was below the plan card, which was below the owner's controls. Here it is
  the whole page and the bars can have the room to be read.
*/

export default function UsageScreen() {
  const state = useTier();
  const blocked = billingBlocker(state);

  return (
    <HubScreen
      back="/billing"
      backLabel="Bill and usage"
      title="Your usage"
      lead="Counted over a rolling thirty days, so there is no reset day — each request drops off thirty days after you made it."
    >
      {blocked ?? (
        /* No card around it. UsageMeter draws its own bordered panel, and a
           card holding a card is two nested rounded rectangles saying the same
           thing about the same content. */
        <UsageMeter
          routes={state.routes}
          windowSeconds={state.windowSeconds}
          oldestAt={state.oldestAt}
        />
      )}
    </HubScreen>
  );
}
