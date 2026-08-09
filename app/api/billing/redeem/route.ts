import { NextResponse } from "next/server";
import {
  hasBillingSecret,
  isStillEntitled,
  mintAccessToken,
  NO_SECRET_MESSAGE,
  readSeatCode,
  TTL_SECONDS,
} from "@/lib/entitlement";
import { hasStripeKey, NO_STRIPE_MESSAGE } from "@/lib/stripe";

/*
  Redeem a school seat.

  A learner at a school that bought seats has no card and never sees Checkout;
  they paste the code their teacher gave them and get the same access token a
  subscriber gets. From here on the two are indistinguishable to the rest of
  the app.
*/

export async function POST(req: Request) {
  if (!hasStripeKey()) {
    return NextResponse.json({ error: NO_STRIPE_MESSAGE }, { status: 503 });
  }
  if (!hasBillingSecret()) {
    return NextResponse.json({ error: NO_SECRET_MESSAGE }, { status: 503 });
  }

  let code = "";
  try {
    const body = (await req.json()) as { code?: unknown };
    if (typeof body?.code === "string") code = body.code;
  } catch {
    // Handled by the emptiness check below.
  }
  if (!code.trim()) {
    return NextResponse.json({ error: "Enter the code your school gave you." }, { status: 400 });
  }

  const seat = readSeatCode(code);
  if (!seat) {
    return NextResponse.json(
      { error: "That code is not valid. Check it was pasted in full." },
      { status: 400 },
    );
  }

  try {
    if (!(await isStillEntitled("seat", seat.inv))) {
      return NextResponse.json(
        { error: "That code is not active yet. It works once your school's invoice is paid." },
        { status: 402 },
      );
    }
    return NextResponse.json({
      token: mintAccessToken("seat", seat.inv),
      expiresIn: TTL_SECONDS,
      seat: seat.n,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not check that code.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
