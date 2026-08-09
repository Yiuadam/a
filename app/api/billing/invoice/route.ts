import { NextResponse } from "next/server";
import { hasBillingSecret, mintSeatCode, NO_SECRET_MESSAGE, safeEqual } from "@/lib/entitlement";
import { hasStripeKey, NO_STRIPE_MESSAGE, stripe } from "@/lib/stripe";

/*
  Sell a block of seats to a school, on an invoice rather than a card.

  Language schools and tutoring centres buy for a cohort and pay from a finance
  department: they want a document with a due date and a bank transfer option,
  not a subscription page. Stripe Invoicing sends and chases that document, and
  each seat on it becomes a code a learner can redeem at /redeem.

  This is staff-operated, not a customer-facing endpoint — it creates billable
  records, so it is behind BILLING_ADMIN_SECRET rather than the paywall.
*/

const MAX_SEATS = 500;

function authorised(req: Request): boolean {
  const expected = process.env.BILLING_ADMIN_SECRET;
  if (!expected) return false;
  return safeEqual(req.headers.get("x-admin-secret") ?? "", expected);
}

function configError(): NextResponse | null {
  if (!hasStripeKey()) return NextResponse.json({ error: NO_STRIPE_MESSAGE }, { status: 503 });
  if (!hasBillingSecret()) return NextResponse.json({ error: NO_SECRET_MESSAGE }, { status: 503 });
  return null;
}

/** Create, finalise and email an invoice for `seats` seats. */
export async function POST(req: Request) {
  const bad = configError();
  if (bad) return bad;
  if (!authorised(req)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 404 });
  }

  const price = process.env.STRIPE_SEAT_PRICE_ID;
  if (!price) {
    return NextResponse.json(
      { error: "No seat price is configured. Set STRIPE_SEAT_PRICE_ID (see .env.example)." },
      { status: 503 },
    );
  }

  let email = "";
  let name = "";
  let seats = 0;
  let daysUntilDue = 30;
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (typeof body.email === "string") email = body.email.trim();
    if (typeof body.name === "string") name = body.name.trim();
    if (typeof body.seats === "number") seats = Math.floor(body.seats);
    if (typeof body.daysUntilDue === "number") daysUntilDue = Math.floor(body.daysUntilDue);
  } catch {
    // Handled by the validation below.
  }

  if (!email.includes("@")) {
    return NextResponse.json({ error: "A billing email is required." }, { status: 400 });
  }
  if (!Number.isFinite(seats) || seats < 1 || seats > MAX_SEATS) {
    return NextResponse.json(
      { error: `Seats must be between 1 and ${MAX_SEATS}.` },
      { status: 400 },
    );
  }
  if (!Number.isFinite(daysUntilDue) || daysUntilDue < 1 || daysUntilDue > 180) {
    return NextResponse.json({ error: "Payment terms must be 1-180 days." }, { status: 400 });
  }

  try {
    const s = stripe();
    const customer = await s.customers.create({ email, name: name || undefined });

    // The invoice is created before its line, and told not to sweep in pending
    // items, so it can only ever contain the seats asked for here.
    const invoice = await s.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: daysUntilDue,
      pending_invoice_items_behavior: "exclude",
      auto_advance: false,
      description: `BandUp Plus — ${seats} learner ${seats === 1 ? "seat" : "seats"}`,
    });
    if (!invoice.id) {
      return NextResponse.json({ error: "Stripe returned an invoice with no id." }, { status: 502 });
    }

    // `pricing: { price }` rather than a bare `price` — the flat form was
    // retired in the API version this SDK pins.
    await s.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id,
      pricing: { price },
      quantity: seats,
    });
    await s.invoices.finalizeInvoice(invoice.id);
    const sent = await s.invoices.sendInvoice(invoice.id);

    return NextResponse.json({
      invoiceId: invoice.id,
      customerId: customer.id,
      status: sent.status,
      hostedInvoiceUrl: sent.hosted_invoice_url,
      seats,
      // Codes are valid only while the invoice reads as paid, so handing them
      // over now is safe: they simply do not work until the school pays.
      codes: Array.from({ length: seats }, (_, i) => mintSeatCode(invoice.id as string, i + 1)),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not raise that invoice.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

/** Re-issue the seat codes for an invoice already raised. */
export async function GET(req: Request) {
  const bad = configError();
  if (bad) return bad;
  if (!authorised(req)) {
    return NextResponse.json({ error: "Not authorised." }, { status: 404 });
  }

  const invoiceId = new URL(req.url).searchParams.get("invoice")?.trim() ?? "";
  if (!invoiceId.startsWith("in_")) {
    return NextResponse.json({ error: "Pass ?invoice=in_..." }, { status: 400 });
  }

  try {
    const invoice = await stripe().invoices.retrieve(invoiceId);
    const seats = invoice.lines.data.reduce((n, line) => n + (line.quantity ?? 0), 0);
    return NextResponse.json({
      invoiceId,
      status: invoice.status,
      seats,
      codes: Array.from({ length: seats }, (_, i) => mintSeatCode(invoiceId, i + 1)),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not read that invoice.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
