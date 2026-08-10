/*
  The console's own chrome: a sidebar, and a page area beside it.

  The site's header and footer stand down here (components/SiteHeader.tsx and
  SiteFooter.tsx both check the path), because a learner's navigation wrapped
  around an owner's dashboard reads as two applications stacked on top of each
  other. This is a different room in the same building.

  The sidebar is dark against a light page on purpose, and it is the only place
  in BandUp that is. The app is warm and quiet because a learner is going to
  spend three hours in it; a console is glanced at, and the contrast is what
  makes "am I in the admin area" answerable from the corner of an eye.
*/

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-[100dvh] bg-slate-100">{children}</div>;
}
