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
  private var highlights: [UIVisualEffectView] = []
  private var rows: [NavRowControl] = []
  private var titles: [UILabel] = []

  // MARK: - Metrics

  private static let horizontalMargin: CGFloat = 16
  private static let cardGap: CGFloat = 14
  /// Inside this distance the container lets two cards' glass flow together.
  /// Deliberately under the gap above: the cards should read as one material,
  /// not fuse into a single slab with headings printed on it.
  private static let containerSpacing: CGFloat = 10
  private static let cardCorner: CGFloat = 22
  private static let cardPadding: CGFloat = 10
  private static let rowCorner: CGFloat = 13
  /* fileprivate, because NavRowControl below lays a row out and these are the
     row's measurements — one copy of each number rather than two that could
     drift, which is what would put the highlight pill somewhere other than
     over the row it is marking. */
  fileprivate static let rowHeight: CGFloat = 44
  fileprivate static let rowPaddingX: CGFloat = 12
  /// 21px on the website; 22 here, the same rounding the bar's own glyphs take.
  fileprivate static let iconSize: CGFloat = 22
  fileprivate static let iconGap: CGFloat = 11
  /// How much of the blurred image of the page is blended back over the sharp
  /// one — the closest thing to a blur radius UIKit offers. See build().
  private static let backdropAlpha: CGFloat = 0.72
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

      Ultra-thin rather than a heavier material: the page has to stay visibly
      *there* behind the list — that is what makes the cards read as floating
      over the app rather than as a new screen — and glass with nothing behind
      it has nothing to bend. The bar learned that the hard way; see the
      long note in NativeChromeView.applyTheme() about a surface that has
      nothing to refract.
    */
    backdropView = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
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

  private func buildCard(_ group: Group) -> UIVisualEffectView {
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
      The highlight for the current page, and it is a real piece of glass
      rather than a painted pill — nested inside the card's own glass, which is
      what makes it read as a thicker patch of the same material rather than as
      a sticker on top of it. It goes in before the rows so it sits behind
      them: a label read *through* frosted glass is a smear, which the bar's
      knob spent a long time proving.
    */
    /* The effect itself is set in applyTheme(_:), because it carries the
       theme's colour and the theme can change while this is on screen. */
    let highlight = UIVisualEffectView(effect: nil)
    highlight.translatesAutoresizingMaskIntoConstraints = false
    highlight.isUserInteractionEnabled = false
    if #available(iOS 26.0, *) {
      highlight.cornerConfiguration = .corners(radius: .fixed(NativeNavListViewController.rowCorner))
    } else {
      highlight.layer.cornerRadius = NativeNavListViewController.rowCorner
      highlight.layer.cornerCurve = .continuous
      highlight.clipsToBounds = true
    }
    highlight.isHidden = true
    inner.addSubview(highlight)
    highlights.append(highlight)

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
      NSLayoutConstraint.activate([
        highlight.leadingAnchor.constraint(equalTo: currentRow.leadingAnchor),
        highlight.trailingAnchor.constraint(equalTo: currentRow.trailingAnchor),
        highlight.topAnchor.constraint(equalTo: currentRow.topAnchor),
        highlight.bottomAnchor.constraint(equalTo: currentRow.bottomAnchor),
      ])
    }

    return card
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

    So it takes the treatment the theme knob takes on the bar, which is the
    exactly analogous element — the thing that says which one of these you are
    on — and for the reason set out there: a surface this small reads a tint as
    the glass being thicker rather than as the glass being covered up. It is
    the theme's own knob colour, so Dark stays the grey disc the website paints
    there rather than turning into a white one.
  */
  private static func highlightEffect(tint: UIColor) -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      let effect = UIGlassEffect(style: .regular)
      effect.tintColor = tint
      return effect
    }
    return UIBlurEffect(style: .systemMaterial)
  }

  /// How much of the theme's knob colour the current row's pill carries.
  /// Lower than the knob's own 0.7: this pill is the full width of a card
  /// rather than a 46pt disc, and the same strength over that area stops
  /// being a marker and becomes a second card.
  private static let highlightAlpha: CGFloat = 0.42

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
    let tint = colors.knobFill.withAlphaComponent(NativeNavListViewController.highlightAlpha)
    for highlight in highlights {
      highlight.effect = NativeNavListViewController.highlightEffect(tint: tint)
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
