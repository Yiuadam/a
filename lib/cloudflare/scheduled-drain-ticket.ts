/*
  A single-use ticket, minted by the cron handler and honoured once.

  This is the whole authentication for /api/internal/replica-drain, and it is
  deliberately not a secret anybody has to configure. See that route for why.

  The value never leaves the isolate: cloudflare/worker-entry.mjs mints one,
  puts it here, calls the app's own fetch handler in process, and clears it in
  a `finally`. A caller from the outside has nothing to present, and between
  runs the set below is empty, so there is nothing to present *to*.

  A set rather than a single value because two cron invocations can overlap in
  one isolate — a slow run and the next tick — and the second one arriving must
  not invalidate the first one's ticket mid-flight.
*/

export const SCHEDULED_DRAIN_HEADER = "x-bandup-scheduled-drain";

const MIN_TICKET_LENGTH = 32;

interface TicketHost {
  __bandupScheduledDrainTickets?: Set<string>;
}

/*
  Module state would be the obvious home, and it is the wrong one: the Worker
  entry and the Next server are two separate module graphs in the same isolate,
  so a `const` here is not the `const` the entry can reach. The isolate's global
  object is the one thing they genuinely share.
*/
function tickets(): Set<string> {
  const host = globalThis as TicketHost;
  host.__bandupScheduledDrainTickets ??= new Set<string>();
  return host.__bandupScheduledDrainTickets;
}

export function issueScheduledDrainTicket(value: string): void {
  if (value.length >= MIN_TICKET_LENGTH) tickets().add(value);
}

export function revokeScheduledDrainTicket(value: string): void {
  tickets().delete(value);
}

/**
 * True once per ticket. The header is compared in constant time and the ticket
 * is spent on the way past, so a replay of the same value fails even inside
 * the window where the original was still valid.
 */
export function consumeScheduledDrainTicket(presented: string | null): boolean {
  if (!presented || presented.length < MIN_TICKET_LENGTH) return false;
  let matched: string | null = null;
  for (const ticket of tickets()) {
    if (constantTimeEquals(ticket, presented)) matched = ticket;
  }
  if (!matched) return false;
  tickets().delete(matched);
  return true;
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
