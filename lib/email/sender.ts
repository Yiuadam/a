import { assertServerOnly } from "@/lib/auth/server-only";
import { resendApiKey } from "@/lib/auth/env";

const MODULE = "lib/email/sender.ts";
const RESEND_TIMEOUT_MS = 10_000;

/** The one shape every provider below accepts, and the only one a caller writes. */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/*
  Structural rather than `Env["EMAIL"]`: the app's own message shape is what
  the existing binding is actually called with (see lib/auth/native-email.ts
  before this file existed), so naming the shape here rather than importing
  the generated Cloudflare types keeps this module checkable without a
  `wrangler types` run, and keeps the two providers on equal footing below.
*/
type CloudflareEmailBinding = { send(message: EmailMessage): Promise<unknown> };

/**
 * Resend's transactional-send endpoint, called directly over `fetch` rather
 * than through their SDK — one JSON POST is the whole integration, and a
 * dependency would not make it any smaller.
 */
export function resendSender(apiKey: string, fetchImpl = fetch): EmailSender {
  return {
    async send(message: EmailMessage): Promise<void> {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        /*
          Never the response body: Resend's own error payloads echo the
          request back, which would put a learner's address in a message a
          caller might log or surface. The status code is enough to act on,
          and the key that would make the call succeed belongs in no Error.
        */
        throw new Error(`Resend rejected the email (HTTP ${response.status})`);
      }
    },
  };
}

/**
 * A thin adapter so the existing Cloudflare binding satisfies `EmailSender`
 * too. The real binding resolves with an `EmailSendResult`, which every
 * caller here already ignores — `await` and drop it, rather than widen
 * `EmailSender.send` to a return value only one of its two providers has.
 */
export function cloudflareSender(binding: CloudflareEmailBinding): EmailSender {
  return {
    async send(message) {
      await binding.send(message);
    },
  };
}

/**
 * Email Sending on the Workers Free plan only reaches addresses the owner has
 * verified in their own Cloudflare account, which is no use for a learner's
 * inbox — so a Free-plan deployment needs an HTTP provider instead. The
 * secret decides which this is: set it and Resend sends both native-account
 * emails; leave it unset on a Paid account and the Cloudflare binding keeps
 * doing the job it always has.
 */
export function emailSender(bindings: { email?: CloudflareEmailBinding }): EmailSender | null {
  assertServerOnly(MODULE);
  const apiKey = resendApiKey();
  if (apiKey) return resendSender(apiKey);
  if (bindings.email) return cloudflareSender(bindings.email);
  return null;
}
