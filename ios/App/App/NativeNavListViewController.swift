import UIKit

/*
  The navigation menu, in real glass, presented with Apple's zoom transition so
  the list grows out of the bar's own menu button.

  Why this is native at all. The website's sheet animates itself outward from
  the menu button by reading that button's x with getBoundingClientRect and
  handing it to a CSS transform-origin. Inside the app the button is not in the
  DOM at all — it is a UIButton on NativeChromeView, drawn above the WKWebView —
  so there is nothing for the web sheet to originate from, and it grew from the
  middle of the screen instead. UIViewController.preferredTransition = .zoom
  takes the source view directly, which is the one arrangement where a native
  button and the surface it opens can be the same continuous piece of motion.

  What this file does NOT own is the list itself. lib/nav.ts is the single
  source of truth for every destination, and it varies by build — the iOS
  bundle has no /pricing or /billing in it — so the structure arrives across
  the Capacitor bridge from the web app and this renders whatever it is given.
  Nothing about the sixteen rows is written down in Swift; see setNavItems in
  NativeChromePlugin.swift.

  The icons are the website's own artwork rather than SF Symbols, traced out of
  components/CardIcon.tsx and components/Icons.tsx into template SVG assets in
  Assets.xcassets. A learner should see the same glyph beside "Reading" in the
  app that they see on the site; a system symbol would be a different drawing
  in a different family.
*/
final class NativeNavListViewController: UIViewController {
  // MARK: - Data

  /// One destination. `icon` is the web's own key — "listening", "plan" — not
  /// an asset name, so the mapping to artwork stays here and lib/nav.ts and
  /// SiteHeader stay the only places that decide what the menu contains.
  struct Item {
    let href: String
    let label: String
    let icon: String?
    let isCurrent: Bool
  }

  struct Group {
    let title: String
    let items: [Item]
  }

  /// Raised once the dismissal has finished, so the page underneath only
  /// changes after the zoom has unwound — a route change mid-transition tears
  /// down the web view the transition is animating over.
  var onSelect: ((String) -> Void)?
  /// Raised for every other way out: the menu button tapped again, or the
  /// interactive swipe the zoom transition provides for free.
  var onDismissed: (() -> Void)?
  /*
    Raised once this controller's view is in the window and before the
    transition draws its first frame, which is the one moment the bar's
    ordering can be restored without a flash.

    It exists because present(_:animated:) does not build the presentation
    while you wait. Logged from the simulator: when present() returned, the
    window still held only the root view and the bar; a run loop turn later it
    held four subviews, with this controller's UITransitionView added above the
    bar. So the plugin cannot re-front the bar at the call site — there is
    nothing to be in front of yet — and the earliest honest signal that there
    is, is this controller appearing.
  */
  var onWillAppear: (() -> Void)?

  private let groups: [Group]
  private var theme: String
  /// How much of the top of the screen the native bar occupies. The list
  /// starts below it and hands touches above it back to the bar — see
  /// PassthroughView.
  private let topInset: CGFloat
  private weak var passthroughTarget: UIView?

  private var pendingHref: String?
  private var reported = false

  // MARK: - Views

  private let backdropView: UIVisualEffectView
  private let scrimView = UIView()
  private let scrollView = UIScrollView()
  /// Holds the three group cards so their glass behaves as one substance
  /// rather than as three stickers — see NativeChromeView.containerEffect(),
  /// which uses the same effect for the account button and theme control.
  private let containerEffectView: UIVisualEffectView
  private let stack = UIStackView()
  private var cards: [UIVisualEffectView] = []
  /// The hosts that carry the cards' shadows, kept because the two strengths
  /// are the theme's and the theme can change while this is on screen.
  private var shadowHosts: [CardShadowView] = []
  private var highlights: [UIVisualEffectView] = []
  /// The fill and hairline inside each highlight — see buildCard for why they
  /// are a view of their own rather than properties of the glass.
  private var highlightOutlines: [UIView] = []
  private var rows: [NavRowControl] = []
  private var titles: [UILabel] = []

  // MARK: - Metrics

  private static let horizontalMargin: CGFloat = 16
  private static let cardGap: CGFloat = 14
  /// Inside this distance the container lets two cards' glass flow together.
  /// Deliberately under the gap above: the cards should read as one material,
  /// not fuse into a single slab with headings printed on it.
  private static let containerSpacing: CGFloat = 10
  /*
    The website's own corners, resolved at the size a phone actually renders
    them, rather than a rounding of the desktop numbers.

    `.card` in app/globals.css rounds at --radius-2xl, which is 2.5rem, and
    `.nav-menu-selector` — the pill that marks the current row there — rounds at
    --radius-xl, 1.75rem, over a 2.75rem row. Read against the usual 16px root
    those come out 40 and 28, and that is the trap: app/globals.css sets
    `html { font-size: 17px }` under `@media (max-width: 480px)`, and every
    iPhone is under it. So on the screen this is meant to match, 2.5rem is
    42.5px and 1.75rem is 29.75px. The 42.5 is not arithmetic done here either
    — the file names that number itself, in the note above
    `.dashboard-screen .dashboard-card-grid .card.card`.

    The decimal stays. Matching is the whole point of the number, and 42 would
    be a deliberate half-point of mismatch that CGFloat has no trouble carrying.

    The row is rounded to 30 rather than kept at 29.75. It is the absolute
    radius that is being matched — as the card's is — and the native row is
    44pt against the web's 46.75, so this is a hair rounder in proportion than
    the website and identical in the dimension a corner is actually seen in.
  */
  private static let cardCorner: CGFloat = 42.5
  /// `p-3` on the website's own `.nav-menu-group`, and the same 17px root as
  /// the corners above turns that into 12.75 rather than 12 — confirmed in the
  /// browser, where the computed padding at a 375px viewport is 12.75 on all
  /// four sides. The decimal stays for the reason the radius's does.
  private static let cardPadding: CGFloat = 12.75
  private static let rowCorner: CGFloat = 30
  /*
    How far inside its row the current page's pill is drawn, and the one
    measurement on this screen with no website behind it.

    There the selector fills the row exactly — 2.75rem tall in a 2.75rem row —
    and the owner looked at that here and wanted the marker shorter. So the row
    keeps its 44pt, which is the tap target and Apple's own minimum, and only
    the drawn pill comes in: 4pt at each end for a 36pt marker. That is enough
    to leave a visible margin above and below without the pill stopping short
    of the label it is marking, and it changes nothing about the list's rhythm,
    since the rows themselves have not moved. The pill is a capsule at either
    height, rowCorner being well past half of 36 — though only 26 will read it
    that way on its own, which is a story the corner's own code tells.
  */
  private static let highlightInsetY: CGFloat = 4
  /// The pill's drawn height, and so, halved, the largest radius that means
  /// anything on it. Derived rather than written down, because the inset and
  /// the row height above are the two numbers that decide it and either could
  /// move. See where the corner is set for what needs it.
  private static var highlightHeight: CGFloat { rowHeight - highlightInsetY * 2 }
  /* fileprivate, because NavRowControl below lays a row out and these are the
     row's measurements — one copy of each number rather than two that could
     drift, which is what would put the highlight pill somewhere other than
     over the row it is marking. */
  fileprivate static let rowHeight: CGFloat = 44
  /// `px-3` on the website's row, the same token the card's own `p-3` is, and
  /// so the same 12.75 at a 17px root — which is what makes the pill's ends
  /// line up with the card's inner edge the way they do on the site.
  fileprivate static let rowPaddingX: CGFloat = 12.75
  /// 21px on the website; 22 here, the same rounding the bar's own glyphs take.
  fileprivate static let iconSize: CGFloat = 22
  fileprivate static let iconGap: CGFloat = 11
  /*
    How much of the blurred image of the page is blended back over the sharp
    one — the closest thing to a blur radius UIKit offers.

    This number is a compromise between two things the owner asked for that
    cannot both be had in full, and it is worth writing down why rather than
    letting the next person "fix" it in either direction.

    It was 0.72, and the page stayed readable through the gaps between the
    cards, which they objected to. Taken to 1.0 the text went away — and so did
    the refraction, which they then objected to. That is not a bug in either
    change: refraction is the bending of what lies behind the glass, and a
    fully blurred field has no edges left to bend. The more completely the page
    is hidden, the flatter the glass above it must look.

    0.86 keeps the page as shapes rather than as sentences: enough contrast
    survives for the cards' own material to have something to distort at their
    rims, and not enough for a word to be read out of the gaps. It is the
    setting to revisit if either complaint returns, and the direction to move it
    is whichever of the two the owner minds more that day.
  */
  private static let backdropAlpha: CGFloat = 0.86
  /*
    The card's two shadows, converted from the website's own box-shadow on
    `.nav-menu-group` rather than invented.

    Measured there, in paint order:
      rgba(42,31,24,0.10)   0  1px   2px  0    contact
      rgba(0,0,0,0.18)      0  8px  22px -8px  drop
      rgba(142,104,78,0.07) 0  0    14px  2px  ambient glow

    CSS blur is about twice a CALayer's shadowRadius, so 22 becomes 11 and 14
    becomes 7. CALayer has no spread at all, so spread is carried by the
    shadowPath instead: -8 draws the drop shadow from the card's shape inset by
    8, +2 draws the glow from it outset by 2, both with the corner radius moved
    the same way so the arc stays concentric with the card's.

    The glow is the one the whole change is for. It is --wash-one, the page's
    own warm tone, and it is what lets the card bleed into the blur behind it
    instead of ending at a cut edge. It is meant to be barely nameable; a glow
    you can point at is a halo and is wrong.

    The contact shadow is not drawn. A CALayer carries one shadow, so each of
    these already costs its own layer, and a third at 10% alpha with a 1px
    offset and a 1pt radius lands underneath a 42.5pt corner where the drop
    shadow is already darkening the same edge over twenty points. It is the one
    of the three that would cost most and show least on a list that scrolls.

    Only the two strengths move between themes; every distance here is shared,
    which is why the geometry is a constant and the opacities are a function.
  */
  /* fileprivate for the reason the row's measurements below are: CardShadowView
     casts these and this is where the numbers live, so it reads them rather
     than keeping a second copy that could drift out of step with the corner
     radius they are all derived against. */
  fileprivate static let dropShadowRadius: CGFloat = 11
  fileprivate static let dropShadowOffset = CGSize(width: 0, height: 8)
  fileprivate static let dropShadowSpread: CGFloat = -8
  fileprivate static let glowRadius: CGFloat = 7
  fileprivate static let glowSpread: CGFloat = 2
  fileprivate static let glowColor = UIColor(
    red: 142 / 255, green: 104 / 255, blue: 78 / 255, alpha: 1)

  /*
    How hard each of the two shadows is driven, which the website decides per
    theme and states its reasons for.

    Dark leans on the drop and eases off the glow — 34% and 4% — because a card
    barely lighter than the sheet behind it needs the lift to do the separating,
    and a warm bloom on a near-black ground reads as a smudge rather than as
    light. Light drops the coloured one altogether; the note above
    `html[data-theme="light"] .nav-menu-group` in app/globals.css puts it
    plainly, that the light themes keep the neutral shadow layers and drop only
    the coloured one. Warm is the default pair the rest of this is derived from.

    A theme this does not know about takes Warm's, the same fallback
    NativeChromeView.colors(for:) makes for the same reason.
  */
  private static func shadowStrength(for theme: String) -> (drop: Float, glow: Float) {
    switch theme {
    case "dark": return (0.34, 0.04)
    case "light": return (0.18, 0)
    default: return (0.18, 0.07)
    }
  }
  /// `--nav-scrim` from app/globals.css, to the value.
  private static let scrim = UIColor(red: 28 / 255, green: 20 / 255, blue: 14 / 255, alpha: 0.10)

  // MARK: - Life cycle

  init(groups: [Group], theme: String, topInset: CGFloat, passthroughTarget: UIView?) {
    self.groups = groups
    self.theme = theme
    self.topInset = topInset
    self.passthroughTarget = passthroughTarget
    /*
      The sheet's own material, and it is a blur rather than glass on purpose.
      This is the .nav-paper layer from app/globals.css: its whole job is to
      take the page underneath out of focus so the cards have a quiet field to
      sit on. Glass here would be a third refracting layer between the page and
      the cards, and the cards are the thing meant to be looked at.

      It used to be ultra-thin at 72% alpha, on the argument that the page had
      to stay visibly *there* behind the list — that being what makes the cards
      read as floating over the app rather than as a new screen. That argument
      was not wrong, and it has been overridden rather than forgotten: the owner
      looked at it on the device and could read a heading through the gap
      between two cards, which is not a page kept present, it is a page
      competing with the menu in front of it. Asked for a glow blur that cannot
      be seen through, so thin at full strength, and nothing of the page
      survives as type.
    */
    backdropView = UIVisualEffectView(effect: UIBlurEffect(style: .systemThinMaterial))
    if #available(iOS 26.0, *) {
      let container = UIGlassContainerEffect()
      container.spacing = NativeNavListViewController.containerSpacing
      containerEffectView = UIVisualEffectView(effect: container)
    } else {
      /* No container effect to have below 26, and nothing to stand in for it:
         it governs how neighbouring glass merges, and neighbouring blurs do
         not merge at all. A plain view keeps the hierarchy identical on both
         paths so the constraints below have one shape rather than two. */
      containerEffectView = UIVisualEffectView(effect: nil)
    }
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func loadView() {
    let root = PassthroughView()
    root.passthroughTopInset = topInset
    root.passthroughTarget = passthroughTarget
    root.backgroundColor = .clear
    view = root
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    build()
    applyTheme(theme)
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    onWillAppear?()
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    /*
      One report per lifetime, whichever way this closed. A row tap dismisses
      first and stores its href, so by the time this runs the transition has
      finished unwinding and the web app is free to navigate; everything else —
      the swipe the zoom transition provides, the menu button tapped again —
      falls through to onDismissed so the web's own `openPath` stops claiming
      the menu is open.
    */
    guard !reported else { return }
    reported = true
    if let href = pendingHref { onSelect?(href) } else { onDismissed?() }
  }

  // MARK: - Build

  private func build() {
    /*
      The backdrop is a sibling of the scroll view rather than its host, and
      the reason is one number: alpha.

      As a UIVisualEffectView wrapping the content, dimming it would have
      dimmed the cards with it. Beside the content, its alpha is free to be
      what the look needs — and it needs to be well under 1. A material at full
      strength erases the page instead of softening it: the field between the
      cards came out a flat wash with nothing of the app left in it, when what
      the sheet is for is putting the page out of focus while leaving it
      plainly there. Partial alpha blends the blurred image back over the sharp
      one, which is the closest thing UIKit gives to a blur radius — UIBlurEffect
      has no such knob.
    */
    backdropView.translatesAutoresizingMaskIntoConstraints = false
    backdropView.alpha = NativeNavListViewController.backdropAlpha
    backdropView.isUserInteractionEnabled = false
    view.addSubview(backdropView)

    /* The website's own `--nav-scrim`, and the one colour borrowed from it —
       a tenth of a warm near-black. It is not a fill standing in for glass, it
       is the thing that gives the cards a slightly darker ground to be
       forward of, which is exactly the job it does on the web. */
    scrimView.translatesAutoresizingMaskIntoConstraints = false
    scrimView.isUserInteractionEnabled = false
    scrimView.backgroundColor = NativeNavListViewController.scrim
    view.addSubview(scrimView)

    scrollView.translatesAutoresizingMaskIntoConstraints = false
    scrollView.alwaysBounceVertical = true
    scrollView.showsVerticalScrollIndicator = false
    scrollView.contentInsetAdjustmentBehavior = .never
    view.addSubview(scrollView)

    containerEffectView.translatesAutoresizingMaskIntoConstraints = false
    scrollView.addSubview(containerEffectView)

    stack.axis = .vertical
    stack.spacing = NativeNavListViewController.cardGap
    stack.translatesAutoresizingMaskIntoConstraints = false
    containerEffectView.contentView.addSubview(stack)

    let margin = NativeNavListViewController.horizontalMargin
    /* Every one of the three layers occupies the same box: everything below
       the bar, and nothing above it. The bar is still on screen up there and
       still tappable, exactly as the website's header stays put above its own
       sheet — see PassthroughView. */
    for layer in [backdropView, scrimView, scrollView] {
      NSLayoutConstraint.activate([
        layer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        layer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        layer.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        layer.topAnchor.constraint(equalTo: view.topAnchor, constant: topInset),
      ])
    }

    NSLayoutConstraint.activate([

      containerEffectView.topAnchor.constraint(
        equalTo: scrollView.contentLayoutGuide.topAnchor, constant: margin),
      containerEffectView.bottomAnchor.constraint(
        equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -margin),
      containerEffectView.leadingAnchor.constraint(
        equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: margin),
      containerEffectView.trailingAnchor.constraint(
        equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -margin),
      containerEffectView.widthAnchor.constraint(
        equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -margin * 2),

      stack.leadingAnchor.constraint(equalTo: containerEffectView.contentView.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: containerEffectView.contentView.trailingAnchor),
      stack.topAnchor.constraint(equalTo: containerEffectView.contentView.topAnchor),
      stack.bottomAnchor.constraint(equalTo: containerEffectView.contentView.bottomAnchor),
    ])

    /* The bottom of the last card clears the home indicator. Set as a content
       inset rather than a constraint so the cards themselves keep one shape. */
    scrollView.contentInset.bottom = view.safeAreaInsets.bottom

    for group in groups {
      stack.addArrangedSubview(buildCard(group))
    }
  }

  private func buildCard(_ group: Group) -> UIView {
    let card = UIVisualEffectView(effect: NativeNavListViewController.cardEffect())
    card.translatesAutoresizingMaskIntoConstraints = false
    /*
      Apple's own corner shape rather than a radius we maintain, for the same
      reason the theme knob uses one: cornerConfiguration tells the material
      what shape to render, so nothing has to be clipped to a rectangle and cut
      back down afterwards, and the shape stays right at any size. Below 26
      there is no such thing, and a blur only honours layer.cornerRadius when
      it is clipped — so that path clips and this one does not.
    */
    if #available(iOS 26.0, *) {
      card.cornerConfiguration = .corners(radius: .fixed(NativeNavListViewController.cardCorner))
    } else {
      card.layer.cornerRadius = NativeNavListViewController.cardCorner
      card.layer.cornerCurve = .continuous
      card.clipsToBounds = true
    }
    cards.append(card)

    let inner = card.contentView

    let title = UILabel()
    /* Uppercased and tracked out, the way the website's own group headings are
       — `text-xs font-semibold uppercase tracking-wider`. */
    title.attributedText = NSAttributedString(
      string: group.title.uppercased(),
      attributes: [
        .font: UIFont.systemFont(ofSize: 12, weight: .semibold),
        .kern: 0.7,
      ]
    )
    title.translatesAutoresizingMaskIntoConstraints = false
    inner.addSubview(title)
    titles.append(title)

    /*
      The highlight for the current page, built exactly the way the bar's theme
      track is built, because that is what it is meant to look like.

      Clear glass with a separate view inside it carrying the fill and the
      hairline — not tinted .regular glass, which is what it was and what made
      the owner call its edge blurred. A blurring material softens its own
      boundary; the crispness of the pill bar comes from trackOutline, an
      ordinary UIView with a background colour and a border, sitting inside
      clear glass that does not blur anything. Same arrangement here, same
      result.

      It goes in before the rows so it sits behind them: a label read *through*
      frosted glass is a smear, which the bar's knob spent a long time proving.

      Both the effect and the two colours are set in applyTheme(_:), because
      they are the theme's and the theme can change while this is on screen.
    */
    let highlight = UIVisualEffectView(effect: nil)
    highlight.translatesAutoresizingMaskIntoConstraints = false
    highlight.isUserInteractionEnabled = false
    let highlightOutline = UIView()
    highlightOutline.translatesAutoresizingMaskIntoConstraints = false
    highlightOutline.isUserInteractionEnabled = false
    if #available(iOS 26.0, *) {
      highlight.cornerConfiguration = .corners(radius: .fixed(NativeNavListViewController.rowCorner))
      highlightOutline.cornerConfiguration = .corners(
        radius: .fixed(NativeNavListViewController.rowCorner))
    } else {
      /*
        The same radius, clamped by hand, because down here nothing clamps it.

        rowCorner is 30 against a pill 36 tall, on the note beside it that a
        radius past half the height comes out a capsule because it is brought
        down to fit. cornerConfiguration above does bring it down, which is why
        the plain number is right there. layer.cornerRadius does not: at 30 in
        a 36pt box the two arcs at each end have nowhere to sit side by side,
        so they cross, and the end finishes in a point rather than a
        semicircle. Traced down the left edge on 18.5: a third of the way up
        from the middle, the capsule 26 draws has come in about three points
        from its widest and this had come in eight, which is the difference
        between an end that reads as round and one that reads as a leaf. That
        is what the owner was looking at when they asked for this marker to be
        round.

        Clamped, the shape matches 26's to within a pixel of antialiasing, and
        the continuous cornerCurve below can stay: a continuous curve is the
        wrong shape for a capsule only while there is a radius left over to
        bend past the end of the side, and at exactly half there is not. The
        bar's theme track sits at exactly half too, and its corner carries the
        rest of that.
      */
      let corner = min(
        NativeNavListViewController.rowCorner,
        NativeNavListViewController.highlightHeight / 2
      )
      highlight.layer.cornerRadius = corner
      highlight.layer.cornerCurve = .continuous
      highlight.clipsToBounds = true
      highlightOutline.layer.cornerRadius = corner
    }
    highlightOutline.layer.cornerCurve = .continuous
    highlight.contentView.addSubview(highlightOutline)
    highlight.isHidden = true
    inner.addSubview(highlight)
    highlights.append(highlight)
    highlightOutlines.append(highlightOutline)

    NSLayoutConstraint.activate([
      highlightOutline.leadingAnchor.constraint(equalTo: highlight.contentView.leadingAnchor),
      highlightOutline.trailingAnchor.constraint(equalTo: highlight.contentView.trailingAnchor),
      highlightOutline.topAnchor.constraint(equalTo: highlight.contentView.topAnchor),
      highlightOutline.bottomAnchor.constraint(equalTo: highlight.contentView.bottomAnchor),
    ])

    let rowStack = UIStackView()
    rowStack.axis = .vertical
    rowStack.translatesAutoresizingMaskIntoConstraints = false
    inner.addSubview(rowStack)

    var currentRow: NavRowControl?
    for item in group.items {
      let row = NavRowControl(item: item)
      row.addTarget(self, action: #selector(rowTapped(_:)), for: .touchUpInside)
      rowStack.addArrangedSubview(row)
      rows.append(row)
      if item.isCurrent { currentRow = row }
    }

    let pad = NativeNavListViewController.cardPadding
    NSLayoutConstraint.activate([
      title.leadingAnchor.constraint(
        equalTo: inner.leadingAnchor, constant: pad + NativeNavListViewController.rowPaddingX),
      title.trailingAnchor.constraint(lessThanOrEqualTo: inner.trailingAnchor, constant: -pad),
      title.topAnchor.constraint(equalTo: inner.topAnchor, constant: pad + 6),

      rowStack.leadingAnchor.constraint(equalTo: inner.leadingAnchor, constant: pad),
      rowStack.trailingAnchor.constraint(equalTo: inner.trailingAnchor, constant: -pad),
      rowStack.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 6),
      rowStack.bottomAnchor.constraint(equalTo: inner.bottomAnchor, constant: -pad),
    ])

    if let currentRow {
      highlight.isHidden = false
      let inset = NativeNavListViewController.highlightInsetY
      NSLayoutConstraint.activate([
        highlight.leadingAnchor.constraint(equalTo: currentRow.leadingAnchor),
        highlight.trailingAnchor.constraint(equalTo: currentRow.trailingAnchor),
        highlight.topAnchor.constraint(equalTo: currentRow.topAnchor, constant: inset),
        highlight.bottomAnchor.constraint(equalTo: currentRow.bottomAnchor, constant: -inset),
      ])
    }

    /*
      The card goes inside a shadow host rather than carrying its shadows
      itself, and for two separate reasons that happen to want the same thing.

      A CALayer has room for one shadow and the website's card has three, so
      even the two being kept here need a layer each. And below 26 the card
      clips itself — that path shapes a blur by cutting a rectangle down to a
      rounded one, which would take the shadow off with the corners. A host
      outside the clip is unaffected by either.
    */
    let host = CardShadowView(card: card, corner: NativeNavListViewController.cardCorner)
    shadowHosts.append(host)
    return host
  }

  // MARK: - Effects

  /*
    Regular, not clear, and untinted.

    Regular renders a visible rim, and the rim is what reads as a card with an
    edge rather than a smudge of the sheet behind it. The tint is deliberately
    absent: the website's card fills are 0.9-opacity CSS whose entire job is to
    imitate glass in an engine that cannot render it, and pouring an imitation
    into the real material can only subtract — that mistake is already recorded
    at length in NativeChromeView.applyTheme(). What makes these cards BandUp's
    is the icon tint, the label colour and the corner shape.
  */
  private static func cardEffect() -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      return UIGlassEffect(style: .regular)
    }
    return UIBlurEffect(style: .systemThinMaterial)
  }

  /*
    The current row's pill, and the one surface here that carries a tint.

    Measured rather than decided: glass on glass with no tint marks nothing.
    A .regular pill nested in a .regular card renders a rim and no fill, which
    on Dark's near-black card is enough to read as a lighter row and on Warm's
    and Light's pale cards is invisible — the rim UIGlassEffect draws is a
    *light* rim, so it has contrast against dark ground and none against light.
    On the first build of this screen "Home" was marked by nothing but its
    label being a shade bolder in two themes out of three.
  */
  private static func highlightEffect() -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      /* Untinted and clear, which is NativeChromeView.pillEffect's own choice
         for the theme track and for the same reason: the colour belongs to the
         outline view inside, where it has a hard edge, rather than to the
         material, where it does not. Not interactive — nothing presses this. */
      return UIGlassEffect(style: .clear)
    }
    return UIBlurEffect(style: .systemMaterial)
  }

  private static func rgba(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat) -> UIColor {
    UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
  }

  /*
    What the current row's pill is made of, and it took two goes to get here.

    It used to borrow the bar knob's own colour, on the reasoning that the knob
    is the exactly analogous element — the thing that says which one of these
    you are on. The colour did not travel with the reasoning. knobFill is
    near-white in two themes of three, because the knob sits on a translucent
    track over the page where near-white is exactly right; poured into a pill
    on a pale card it is white on white, and the row was marked by nothing but
    its label being a shade bolder.

    So the fill is a grey that contrasts with the card it is on rather than one
    borrowed from somewhere else: dark at low alpha on the pale themes, light
    at low alpha on Dark. That is the same move Light's own trackFill in
    NativeChromeView makes — rgba(22,23,26,0.07) — for the same problem.

    The edge is the second half, and it took a wrong turn of its own. It was
    briefly the website's `--glass-edge`, which is what `.nav-menu-selector`
    borders with there — and in Warm that token is rgba(255,255,255,0.32),
    white at a third, which drew a white ring around a grey pill on a pale
    card. The border comes from NativeChromeView's own table instead, because
    the thing this is meant to look like is the pill bar in the bar above, and
    trackBorder is the hairline that pill bar already wears. One table, one
    answer, in three themes.
  */
  private static func highlightFill(for theme: String) -> UIColor {
    switch theme {
    case "light": return rgba(22, 23, 26, 0.12)
    case "dark": return rgba(255, 255, 255, 0.13)
    default: return rgba(42, 37, 33, 0.12)
    }
  }
  /// The hairline's width, which is the website's own 0.6px for this element
  /// rather than the track's 1pt: a line that reads as a drawn edge and one
  /// that reads as a border are different things on the eye, and this pill is
  /// the smaller surface.
  private static let highlightBorderWidth: CGFloat = 0.6

  // MARK: - Theme

  /*
    The same override the bar makes, for the same reason: UIGlassEffect and the
    blur fallback both resolve against the trait collection they render in,
    which by default is the OS appearance rather than BandUp's own theme. Left
    alone, a phone in Light mode showing BandUp in Dark would draw this list
    light with dark text poured into it.
  */
  func applyTheme(_ next: String) {
    theme = next
    let colors = NativeChromeView.colors(for: next)
    view.overrideUserInterfaceStyle = next == "dark" ? .dark : .light

    for title in titles {
      title.textColor = colors.foreground.withAlphaComponent(0.55)
    }
    for row in rows {
      row.apply(iconTint: colors.iconTint, foreground: colors.foreground)
    }
    let shadow = NativeNavListViewController.shadowStrength(for: next)
    for host in shadowHosts {
      host.apply(drop: shadow.drop, glow: shadow.glow)
    }
    for highlight in highlights {
      highlight.effect = NativeNavListViewController.highlightEffect()
    }
    let fill = NativeNavListViewController.highlightFill(for: next)
    for outline in highlightOutlines {
      outline.backgroundColor = fill
      outline.layer.borderWidth = NativeNavListViewController.highlightBorderWidth
      outline.layer.borderColor = colors.trackBorder.cgColor
    }
  }

  // MARK: - Actions

  @objc private func rowTapped(_ sender: NavRowControl) {
    guard pendingHref == nil else { return }
    pendingHref = sender.href
    dismiss(animated: true)
  }
}

/*
  One card's two shadows, and nothing else.

  Two, because a CALayer carries one shadow each and the website's card is lit
  by more than one thing. They sit on sublayers behind the card rather than on
  this view's own layer, and in the order CSS paints them — the glow underneath,
  the drop shadow over it, the card over both. This view draws no pixels of its
  own at all; the shape and the material stay entirely the card's.

  Each shadow is masked to the region outside the card, and that is not tidiness
  either. CSS paints an outer box-shadow only outside the border box. A CALayer
  paints its shadow behind the whole layer, and what is in front of it here is
  translucent glass, so the first build of this showed both shadows straight
  through the card: a drop shadow drawn from a shape inset by eight is almost
  entirely underneath, and the cards came out grey slabs with a light rim
  instead of glass. The mask restores the CSS rule. Masking a layer masks its
  shadow with it, which is usually the thing to work around and is exactly what
  is wanted here.

  Both shadows are given an explicit shadowPath. Without one, CoreAnimation
  works the silhouette out from the layer's contents every time it re-renders,
  and this list scrolls; with one it is two rounded rectangles recomputed only
  when the bounds change. The paths are drawn with a circular corner rather than
  the continuous one the card renders, a difference of about a point on the arc
  and invisible under an eleven-point blur.
*/
private final class CardShadowView: UIView {
  private let glowLayer = CALayer()
  private let dropLayer = CALayer()
  private let glowMask = CAShapeLayer()
  private let dropMask = CAShapeLayer()
  private let corner: CGFloat

  /// How far outside the card each mask lets shadow through. Comfortably past
  /// the widest blur plus its offset and spread, so the mask decides where the
  /// shadow stops on the inside and nothing at all on the outside.
  private static let reach: CGFloat = 48

  init(card: UIView, corner: CGFloat) {
    self.corner = corner
    super.init(frame: .zero)
    translatesAutoresizingMaskIntoConstraints = false
    backgroundColor = .clear

    glowLayer.shadowColor = NativeNavListViewController.glowColor.cgColor
    glowLayer.shadowOffset = .zero
    glowLayer.shadowRadius = NativeNavListViewController.glowRadius
    glowMask.fillRule = .evenOdd
    glowLayer.mask = glowMask
    layer.addSublayer(glowLayer)

    dropLayer.shadowColor = UIColor.black.cgColor
    dropLayer.shadowOffset = NativeNavListViewController.dropShadowOffset
    dropLayer.shadowRadius = NativeNavListViewController.dropShadowRadius
    dropMask.fillRule = .evenOdd
    dropLayer.mask = dropMask
    layer.addSublayer(dropLayer)

    addSubview(card)
    NSLayoutConstraint.activate([
      card.leadingAnchor.constraint(equalTo: leadingAnchor),
      card.trailingAnchor.constraint(equalTo: trailingAnchor),
      card.topAnchor.constraint(equalTo: topAnchor),
      card.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// The only thing about these shadows a theme changes. Set from applyTheme
  /// rather than from init so a theme chosen while the list is open reaches
  /// them, the same as every other colour on this screen.
  func apply(drop: Float, glow: Float) {
    dropLayer.shadowOpacity = drop
    glowLayer.shadowOpacity = glow
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    /* Nothing here is animated, and everything here is a consequence of a
       bounds change rather than a state change — so the implicit animations
       CoreAnimation would give a path or a frame are noise the list can see as
       a shadow lagging behind its card during a rotation. */
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }

    place(glowLayer, glowMask, spread: NativeNavListViewController.glowSpread)
    place(dropLayer, dropMask, spread: NativeNavListViewController.dropShadowSpread)
  }

  /// CSS spread has no CALayer equivalent, so it is carried by the path: the
  /// glow is the card's shape pushed out by two and the drop shadow is it
  /// pulled in by eight, each with its corner moved the same way so the arc
  /// stays concentric with the card's own.
  private func place(_ shadow: CALayer, _ mask: CAShapeLayer, spread: CGFloat) {
    shadow.frame = bounds
    shadow.shadowPath = UIBezierPath(
      roundedRect: bounds.insetBy(dx: -spread, dy: -spread),
      cornerRadius: max(0, corner + spread)
    ).cgPath

    let reach = CardShadowView.reach
    mask.frame = bounds.insetBy(dx: -reach, dy: -reach)
    let outer = CGRect(origin: .zero, size: mask.frame.size)
    let hole = UIBezierPath(
      roundedRect: CGRect(x: reach, y: reach, width: bounds.width, height: bounds.height),
      cornerRadius: corner
    )
    let ring = UIBezierPath(rect: outer)
    ring.append(hole)
    mask.path = ring.cgPath
  }
}

/*
  Lets the native bar keep working while the list is open.

  The list covers everything below the bar and nothing above it, which is what
  the website does too — its sheet is `top-[var(--header-h)] bottom-0`, so the
  header stays put and stays live above it. A presented view controller's view
  is the full window regardless, so the strip the bar occupies has to hand its
  touches back.

  Returning nil is not enough, and that was measured rather than assumed: with
  the list up, taps on the theme control and the account button did nothing at
  all. A modally presented view controller's view sits inside a container view
  UIKit owns, and UIView.hitTest returns *self* when the point is inside its
  bounds and no subview claimed it — so a nil from here only moved the problem
  up one level, where the container swallowed the touch instead.

  So the strip is forwarded explicitly to the view that should have it. Handing
  back a view from another part of the hierarchy is the same move
  NativeChromeView.hitTest already makes to give the theme knob a touch its own
  glass needs; UIKit delivers the touch to whatever view is returned.

  It is a backstop now rather than the working path. The bar lives in the
  window and is brought in front of this presentation's container — see
  attachChrome in NativeChromePlugin.swift, and the defect that forced it — so
  the window hit-tests the bar before it ever reaches this view. What is left
  here still costs nothing and still answers correctly for the one arrangement
  that can leave the bar behind the container: a bar attached before the scene
  had a window.

  One thing this cannot give back is the menu button, which Apple's zoom
  transition hides for as long as the list it became is on screen — the same
  way Photos hides the thumbnail you opened. The swipe the transition provides,
  and choosing a destination, are the ways out.
*/
private final class PassthroughView: UIView {
  var passthroughTopInset: CGFloat = 0
  weak var passthroughTarget: UIView?

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard point.y < passthroughTopInset else { return super.hitTest(point, with: event) }
    guard let target = passthroughTarget, target.window != nil else { return nil }
    return target.hitTest(convert(point, to: target), with: event)
  }
}

/*
  One destination.

  A UIControl with a plain image view and label rather than a configured
  UIButton, and for the reason NativeChromeView.configure(_:asset:size:label:)
  gives: a configuration renders its image at whatever size the asset happens
  to be, where these have to land on the size the website measured. Auto Layout
  is told the number instead.
*/
private final class NavRowControl: UIControl {
  let href: String

  private let iconView = UIImageView()
  private let label = UILabel()
  private let isCurrent: Bool

  init(item: NativeNavListViewController.Item) {
    href = item.href
    isCurrent = item.isCurrent
    super.init(frame: .zero)

    /* A miss — the asset not having made it into the bundle, or the web
       naming an icon nothing was traced for — leaves the row glyph-less
       rather than reaching for an SF Symbol that would not match the site's
       drawing either way. A wrong-looking glyph is worse than none. */
    iconView.image = NavRowControl.artwork(for: item.icon)
    iconView.contentMode = .scaleAspectFit
    iconView.isUserInteractionEnabled = false
    iconView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(iconView)

    label.text = item.label
    label.font = .systemFont(ofSize: 16, weight: .semibold)
    label.numberOfLines = 1
    label.translatesAutoresizingMaskIntoConstraints = false
    addSubview(label)

    isAccessibilityElement = true
    accessibilityLabel = item.label
    accessibilityTraits = item.isCurrent ? [.button, .selected] : [.button]

    let padX = NativeNavListViewController.rowPaddingX
    let icon = NativeNavListViewController.iconSize
    NSLayoutConstraint.activate([
      heightAnchor.constraint(
        greaterThanOrEqualToConstant: NativeNavListViewController.rowHeight),
      iconView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: padX),
      iconView.centerYAnchor.constraint(equalTo: centerYAnchor),
      iconView.widthAnchor.constraint(equalToConstant: icon),
      iconView.heightAnchor.constraint(equalToConstant: icon),
      label.leadingAnchor.constraint(
        equalTo: iconView.trailingAnchor, constant: NativeNavListViewController.iconGap),
      label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -padX),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /*
    The web's icon key mapped to the traced asset, by derivation rather than by
    a table. A table here would be a second list to keep in step with
    MENU_ICONS and HOMEPAGE_MENU_ICONS in components/SiteHeader.tsx, which is
    exactly the drift lib/nav.ts is being kept as the single source of truth to
    avoid — so "listening" finds IconNavListening and a key nothing was traced
    for finds nothing, which the caller already handles.
  */
  private static func artwork(for icon: String?) -> UIImage? {
    guard let icon, !icon.isEmpty else { return nil }
    let name = icon.split(separator: "-").map { $0.capitalized }.joined()
    return UIImage(named: "IconNav\(name)")?.withRenderingMode(.alwaysTemplate)
  }

  func apply(iconTint: UIColor, foreground: UIColor) {
    iconView.tintColor = iconTint
    /* The website draws the current row at full strength and the rest a shade
       back — text-slate-900 against text-slate-700. */
    label.textColor = isCurrent ? foreground : foreground.withAlphaComponent(0.78)
  }

  override var isHighlighted: Bool {
    didSet {
      /* The press state a `.system` button would have given for free, made by
         hand because the glyph and label here are plain subviews. Fading the
         control fades both together as the one surface they read as. */
      UIView.animate(withDuration: 0.12) {
        self.alpha = self.isHighlighted ? 0.55 : 1
      }
    }
  }
}
