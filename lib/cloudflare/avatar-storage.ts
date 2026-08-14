/**
 * Commit a new immutable avatar without ever deleting the active object first.
 * The callbacks keep the ordering independently testable from D1/R2 bindings.
 */
export async function replaceAvatarObject(options: {
  previousKey: string | null;
  nextKey: string;
  storeNext: () => Promise<void>;
  setPointer: (key: string) => Promise<boolean>;
  deleteObject: (key: string) => Promise<void>;
  onDeleteFailure?: (key: string) => Promise<void>;
}): Promise<boolean> {
  await options.storeNext();

  let pointed = false;
  try {
    pointed = await options.setPointer(options.nextKey);
  } catch {
    pointed = false;
  }
  if (!pointed) {
    // Do not delete an object that was already the live pointer: a retry may
    // upload the same content-addressed key.
    if (options.nextKey !== options.previousKey) {
      try {
        await options.deleteObject(options.nextKey);
      } catch {
        // An unreferenced object is safer than deleting the still-live one.
      }
    }
    return false;
  }

  if (options.previousKey && options.previousKey !== options.nextKey) {
    try {
      await options.deleteObject(options.previousKey);
    } catch {
      // Pointer correctness wins over orphan cleanup. Persist the exact key so
      // a later pointer-safe sweep can retry rather than leaking it silently.
      await options.onDeleteFailure?.(options.previousKey).catch(() => undefined);
    }
  }
  return true;
}

/** Clear the pointer first, then remove the object it used to name. */
export async function clearAvatarObject(options: {
  previousKey: string | null;
  clearPointer: () => Promise<boolean>;
  deleteObject: (key: string) => Promise<void>;
  onDeleteFailure?: (key: string) => Promise<void>;
}): Promise<boolean> {
  let cleared = false;
  try {
    cleared = await options.clearPointer();
  } catch {
    cleared = false;
  }
  if (!cleared) return false;
  if (options.previousKey) {
    try {
      await options.deleteObject(options.previousKey);
    } catch {
      await options.onDeleteFailure?.(options.previousKey).catch(() => undefined);
    }
  }
  return true;
}
