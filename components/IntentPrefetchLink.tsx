"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useRouter } from "next/navigation";

type Props = ComponentProps<typeof Link>;

/*
  Preload one route only after the learner shows intent.

  Automatic viewport prefetching once launched every visible destination at
  the same time. On the old 10 ms Worker limit that produced Error 1102; even
  with the paid limit it wastes bandwidth and CPU on pages the learner never
  opens. Pointer hover, keyboard focus and touch-down happen early enough to
  hide most of the navigation wait without recreating that request burst.
*/
export default function IntentPrefetchLink({
  href,
  onPointerEnter,
  onFocus,
  onTouchStart,
  ...props
}: Props) {
  const router = useRouter();
  const prefetch = () => router.prefetch(String(href));

  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onPointerEnter={(event) => {
        prefetch();
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        prefetch();
        onFocus?.(event);
      }}
      onTouchStart={(event) => {
        prefetch();
        onTouchStart?.(event);
      }}
    />
  );
}
