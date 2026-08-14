"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authedFetch } from "@/lib/account";
import { apiUrl } from "@/lib/api";
import AvatarEditor from "./AvatarEditor";
import { MAX_SOURCE_BYTES } from "./condense";
import { publishProfileUpdate } from "./profileEvents";
import type { ProfileFields } from "./types";
import AccountIdentityForm from "./AccountIdentityForm";
import LoadingIndicator from "@/components/LoadingIndicator";

/*
  Who the learner is: their picture, their name, their date of birth, and the
  address they signed in with.

  This used to sit in the same component as the plan and the usage counter, and
  the two were interleaved on the page — the tier and the daily allowance
  above, the name and the picture below, one undifferentiated stack of cards.
  They are not the same subject. One is what somebody is called; the other is
  what they are paying for and how much of it they have left. Splitting them
  means a learner looking for either can find it, and it means neither section
  has to hedge its heading to cover the other.

  Every account has a username. The display name can be finished later, so the
  reminder remains visible without locking somebody out. The picture and
  birthday are optional, and no profile field grants organization access.
*/

export default function ProfileSection({ sessionEmail }: { sessionEmail: string | null }) {
  const [profile, setProfile] = useState<ProfileFields | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [problem, setProblem] = useState<string | null>(null);

  /*
    The file waiting to be framed. Holding the File rather than a boolean is
    what lets the editor be created fresh for each picture: a new File is a new
    identity, so its decoding effect re-runs, and there is no state left over
    from the last attempt to clear.
  */
  const [pending, setPending] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    authedFetch(apiUrl("/api/account/profile"))
      .then(async (res) => {
        if (!res.ok) throw new Error("profile unavailable");
        return (await res.json()) as ProfileFields;
      })
      .then((body) => {
        if (!alive) return;
        setProfile(body);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, []);

  function pickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Clearing the input lets the same file be chosen twice running, which is
    // what happens when the first attempt failed.
    e.target.value = "";
    if (!file) return;

    setProblem(null);

    /*
      Checked here as well as inside the editor, so that a file which is never
      going to work says so on the page instead of opening a dialog that can
      only apologise. Anything under the ceiling goes to the editor whatever
      its resolution — the browser shrinks it there, and what finally reaches
      the upload route is a small square. See ./condense.ts.
    */
    if (file.size > MAX_SOURCE_BYTES) {
      setProblem(
        "That picture is larger than 10 MB. Please choose a smaller one, or take a new photo.",
      );
      return;
    }
    setPending(file);
  }

  /*
    Both of these are wrapped because the editor takes them as dependencies of
    the effect that installs its Escape key, its outside-tap closer and its
    body-scroll lock — and that effect restores focus when it is torn down. A
    fresh arrow function on every render of this card would tear that effect
    down and rebuild it each time, which pulls focus back to the avatar button
    in the middle of whatever the learner was doing in the dialog.
  */
  const cancelEditor = useCallback(() => setPending(null), []);

  const upload = useCallback(async function upload(picture: Blob) {
    setPending(null);
    setProblem(null);
    setState("saving");
    const form = new FormData();
    /*
      A filename is supplied because a Blob without one arrives as "blob", and
      a nameless upload is harder to recognise in a storage log. It carries no
      authority: the route names the stored object itself, from the session
      user's id, and decides the type from the file's first bytes.
    */
    const extension = picture.type === "image/webp" ? "webp" : "jpg";
    form.append("avatar", picture, `avatar.${extension}`);
    try {
      const res = await authedFetch(apiUrl("/api/account/avatar"), { method: "POST", body: form });
      const body = (await res.json()) as { avatarUrl?: string | null; error?: string };
      if (!res.ok) {
        setProblem(body.error ?? "That picture didn't upload. Please try again.");
        setState("ready");
        return;
      }
      const avatarUrl = body.avatarUrl ?? null;
      setProfile((p) => (p ? { ...p, avatarUrl } : p));
      publishProfileUpdate({ avatarUrl });
      setState("ready");
    } catch {
      setProblem("That picture didn't upload. Please check your connection and try again.");
      setState("ready");
    }
  }, []);

  async function removeAvatar() {
    setProblem(null);
    setState("saving");
    try {
      const res = await authedFetch(apiUrl("/api/account/avatar"), { method: "DELETE" });
      if (!res.ok) throw new Error("avatar removal failed");
      setProfile((p) => (p ? { ...p, avatarUrl: null } : p));
      publishProfileUpdate({ avatarUrl: null });
    } catch {
      setProblem("That didn't work. Please try again.");
    }
    setState("ready");
  }

  if (state === "loading") {
    return (
      <section className="card">
        <p className="text-sm text-slate-500"><LoadingIndicator label="Loading your details…" /></p>
      </section>
    );
  }

  if (state === "error") {
    return (
      <section className="card">
        <p className="text-[15px] leading-7 text-slate-600">
          Your details aren&rsquo;t loading right now. Nothing has changed — please try again in a
          minute.
        </p>
      </section>
    );
  }

  const busy = state === "saving";
  const email = profile?.email ?? sessionEmail;
  const initial = (profile?.displayName || email || "?").trim().charAt(0).toUpperCase();
  const hasPicture = Boolean(profile?.avatarUrl);

  return (
    <section className="account-profile-card card">
      <p className="account-profile-intro text-[14px] leading-6 text-slate-600">
        Your display name and username identify this BandUp account. Your photo and date of birth stay optional.
      </p>

      <div className="mt-4 rounded-[var(--radius-xl)] border border-slate-200/70 bg-surface/25 p-3.5">
        <AccountIdentityForm />
      </div>

      <div className="account-profile-photo mt-4 flex items-center gap-4">
        {/*
          The picture is the control. Tapping a photograph to change it is what
          people already expect, and it gives a finger a 64-pixel target
          instead of a line of button text. The button beside it stays because
          the picture on its own is only a hint — an empty circle with an
          initial in it does not obviously invite a tap.
        */}
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          aria-label={hasPicture ? "Change your picture" : "Add a picture"}
          className="group relative h-16 w-16 shrink-0 rounded-full focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-100 disabled:opacity-50"
        >
          {profile?.avatarUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={profile.avatarUrl}
              alt=""
              width={64}
              height={64}
              decoding="async"
              className="h-16 w-16 rounded-full border border-slate-200 object-cover transition-opacity group-hover:opacity-80"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex h-16 w-16 items-center justify-center rounded-full border border-slate-200 bg-slate-50 text-xl font-semibold text-slate-500 transition-colors group-hover:bg-slate-100"
            >
              {initial}
            </span>
          )}
          <span
            aria-hidden="true"
            className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-surface text-slate-600 shadow-sm"
          >
            <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 6.5h3l1.2-2h6.6l1.2 2h3v10h-15z" />
              <circle cx="10" cy="11" r="3.2" />
            </svg>
          </span>
        </button>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            {hasPicture ? "Change picture" : "Add a picture"}
          </button>
          {hasPicture && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={removeAvatar}>
              Remove
            </button>
          )}
        </div>

        {/*
          `image/*` rather than the three types the bucket stores, because the
          browser re-encodes whatever it can open before anything is sent. That
          is what lets an iPhone photo — HEIC, and not on the bucket's list —
          simply work. A file the browser cannot decode is refused in the
          editor, with a sentence saying what will work.
        */}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          disabled={busy}
          onChange={pickAvatar}
        />
      </div>
      <p className="account-profile-photo-note mt-2 text-xs leading-5 text-slate-500">
        Any phone photo up to 10 MB; BandUp shrinks it before uploading.
      </p>

      <div className="account-profile-form mt-4 grid gap-3 sm:grid-cols-2">
        {/*
          The address is shown and not edited. It is the one field on this card
          that is not the learner's to change here: it comes from whichever
          identity they signed in with, and it is what account recovery emails
          go to, so a text box would promise something this form cannot do.
        */}
        {email && (
          <div className="account-profile-email flex min-w-0 flex-col gap-1.5 sm:col-span-2 sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:items-baseline sm:gap-x-3">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <p className="break-words text-[15px] leading-7 text-slate-600">{email}</p>
            <p className="account-profile-field-note text-xs leading-5 text-slate-500 sm:col-start-2">
              From your sign-in account; it can&rsquo;t be changed here.
            </p>
          </div>
        )}

        {problem && (
          <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[15px] leading-7 text-rose-800 sm:col-span-2">
            {problem}
          </p>
        )}
      </div>

      {pending && <AvatarEditor file={pending} onCancel={cancelEditor} onUse={upload} />}
    </section>
  );
}
