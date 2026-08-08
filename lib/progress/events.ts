/*
  The name of the DOM event a store dispatches after writing progress.

  A module of one constant, on purpose. The stores (lib/store.ts, lib/drills.ts,
  lib/lookups.ts) must stay import-light — they are in every page's bundle — and
  autosync.ts must not be pulled in with them. Both sides import this file and
  nothing else of each other.
*/
export const PROGRESS_WRITE_EVENT = "bandup:progress-write";
