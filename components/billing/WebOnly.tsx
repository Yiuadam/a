import { IS_MOBILE_BUILD, WEB_HOME } from "@/lib/platform";

/*
  What the iOS build says where the web build offers a plan.

  One sentence, no price, no button, no link. That is not timidity — it is the
  whole compliance argument: an iOS app that contains no purchase mechanism for
  digital content owes Apple nothing, and an app that contains a cheaper way to
  buy the same thing is the case they reject. Naming the site in prose is what
  Netflix and Kindle do; making it tappable is where the line is.

  It renders nothing at all on the web, so a call site can drop it in beside
  the real button and let each build show the one that belongs to it.
*/
export default function WebOnly({ what = "This" }: { what?: string }) {
  if (!IS_MOBILE_BUILD) return null;
  return (
    <p className="text-sm leading-6 text-slate-500">
      {what} is part of a subscription, which is managed on {WEB_HOME} rather than in the app.
      Sign in here with the same account and it works straight away.
    </p>
  );
}
