import UIKit

/*
  The app's top bar, in real glass.

  Everything below this view is still the web app rendered by WKWebView. This
  is the one piece of BandUp that is not HTML, and the reason is narrow: the
  refractive glass the site draws in CSS cannot run in WebKit at all. That was
  measured rather than assumed — a displacement filter over a backdrop was
  tried through the combined `backdrop-filter: blur() url()` syntax, through
  `filter` and `backdrop-filter` as separate properties, and with the filter
  on a parent of the blurred element. On a real iPhone all three left the
  backdrop pixel-identical to a control with no filter at all, including one
  deliberately given no blur to hide behind. WebKit will filter an element's
  own painted content and will not filter what is behind it.

  So the site falls back to a drawn bevel there, and the app does not have to:
  UIGlassEffect is the genuine article, and it does the one thing CSS could
  not — bend and brighten what is actually behind it, per frame, for free.

  The controls come with the glass because they have to. A native view cannot
  be interleaved with the DOM: there is no arrangement in which this bar's
  glass sits behind HTML buttons. Either the bar is native with its buttons,
  or it is web with its buttons.
*/
final class NativeChromeView: UIView {
  /// Raised when the user taps a control the web app owns the response to.
  var onHome: (() -> Void)?
  var onMenu: (() -> Void)?
  var onAccount: (() -> Void)?
  var onTheme: ((String) -> Void)?

  /// The bar's content strip, below whatever the status bar and notch take.
  /// NativeChromePlugin adds the safe-area inset to this for the total height,
  /// so the two sides agree by sharing the number rather than repeating it.
  static let barContentHeight: CGFloat = 60

  /// The three stops, in the order the web control shows them.
  static let themes = ["warm", "light", "dark"]
  private static let themeAssets = ["IconThemeWarm", "IconThemeLight", "IconThemeDark"]
  private static let themeLabels = ["Warm theme", "Light theme", "Dark theme"]

  private let barEffectView: UIVisualEffectView
  /// Wraps the account circle and the theme track so their glass can flow
  /// together in motion the way the site's two pills never do on their own —
  /// see containerEffect() below. It carries no fill or border of its own;
  /// everything visible about this pair comes from the two views inside it.
  private let containerEffectView: UIVisualEffectView
  private let accountEffectView: UIVisualEffectView
  private let menuButton = UIButton(type: .system)
  private let accountButton = UIButton(type: .system)
  private let themeTrack: UIVisualEffectView
  /* The track's outline and fill, in a view of their own rather than on
     themeTrack.layer where the border started out. A view draws its own
     layer's border after every subview it has, so an outline there is painted
     straight across whatever sits on top of the track — and the knob is meant
     to dome over that outline and break it, which a border drawn last can
     never allow. Demoting it to the bottom-most subview costs one plain
     UIView and buys the ordering the shape needs. It carries the fill for the
     same reason: see applyTheme() for why the track needs a colour at all. */
  private let trackOutline = UIView()
  private let themeStack = UIStackView()
  private var themeButtons: [UIButton] = []
  private let knob: UIVisualEffectView
  /* The knob's position, as a constraint rather than a frame. A frame set
     from a parent's layoutSubviews races the stack view's own layout pass:
     the stop's frame gets read before the stack has placed it, so the first
     layout puts the knob at zero and every rotation puts it back there. A
     constant on a leading constraint is resolved in the same pass that places
     the stops, whichever order the two happen in. */
  private var knobLeading: NSLayoutConstraint?
  /// The knob's box, also as constraints — grown while a finger holds it and
  /// restored on release, the same reasoning as knobLeading above but for
  /// size rather than position. Both started as anonymous constants; a drag
  /// that can animate them needs a handle on the actual constraint object.
  private var knobWidth: NSLayoutConstraint?
  private var knobHeight: NSLayoutConstraint?
  /// Where, in themeTrack.contentView, the current press began — nil
  /// whenever no finger is down. Read at release to tell a drag from a tap
  /// that merely landed somewhere on the track; see handleKnobPress(_:).
  private var knobPressOrigin: CGPoint?
  private let wordmark = UILabel()
  private let logoView = UIImageView()
  /// The hit target for both of the above at once — see build() for why
  /// they are its subviews rather than two views tapped separately.
  private let homeButton = UIButton(type: .system)
  private let divider = UIView()

  private var selectedTheme = "warm"

  override init(frame: CGRect) {
    /* themeColors is a type-level table, so it can be read here safely even
       though self is not yet a valid instance — reading the selectedTheme
       property instead would not be, this early. Whatever it seeds each
       glass surface with is provisional anyway: build() calls applyTheme()
       before the view is ever displayed, and that pass is what actually
       has to be correct. */
    let initial = NativeChromeView.themeColors["warm"]!
    barEffectView = UIVisualEffectView(effect: NativeChromeView.barEffect(tint: initial.barFill))
    containerEffectView = UIVisualEffectView(effect: NativeChromeView.containerEffect())
    accountEffectView = UIVisualEffectView(effect: NativeChromeView.pillEffect(tint: initial.accountFill))
    themeTrack = UIVisualEffectView(effect: NativeChromeView.pillEffect(tint: initial.trackFill))
    knob = UIVisualEffectView(effect: NativeChromeView.knobEffect(tint: initial.knobFill))
    super.init(frame: frame)
    build()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  // MARK: - Effects

  /*
    Every effect is behind an availability check with a blur underneath it.
    UIGlassEffect is iOS 26, and an app that only looks right on the newest
    release is an app most of its users see broken — the fallback is the same
    material the site's own CSS uses, so older iOS gets the web app's look
    rather than a hole where the bar should be.

    Below 26 that fallback blur cannot carry a tint of its own — UIBlurEffect
    has no such property — which is why applyTheme() also paints one straight
    onto contentView down there. It is the one place in this file a fill sits
    over the glass instead of inside it, and only because the material leaves
    nothing else to colour.
  */
  private static func barEffect(tint: UIColor?) -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      /*
        .regular, not .clear.

        .clear was the obvious choice for a bar meant to let the page show
        through, and on a still screen it looked right. Scrolling it proved
        otherwise: a sign-in form passing underneath stayed legible through
        the glass, so its headings collided with the wordmark and its links
        ran through the theme control — two layers of type competing in the
        same strip. The website's own header is not that transparent either;
        it blurs what passes under it to a wash.

        This is the authentic material either way. .clear is for glass with
        something worth seeing behind it; a bar with controls on it is the
        case .regular exists for.
      */
      let effect = UIGlassEffect(style: .regular)
      if let tint { effect.tintColor = tint }
      return effect
    }
    return UIBlurEffect(style: .systemThinMaterial)
  }

  private static func pillEffect(tint: UIColor?) -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      /* .regular rather than the bar's .clear: the account circle and the
         theme track are meant to read as their own pieces of glass, the way
         the site paints them as two pills with their own fill and border
         rather than controls resting on the bar's material directly. Both
         are real controls a finger lands on, so both are interactive. */
      /*
        .clear, not .regular. The bar above needs .regular because a page
        scrolling under it has to stop being legible before it reaches the
        wordmark. These two are small, bordered, and carry nothing but their
        own glyph, so nothing collides and the clearer material has somewhere
        to show — it is the style meant for glass with content behind it,
        which is what these are.
      */
      let effect = UIGlassEffect(style: .clear)
      if let tint { effect.tintColor = tint }
      effect.isInteractive = true
      return effect
    }
    return UIBlurEffect(style: .systemThinMaterial)
  }

  private static func knobEffect(tint: UIColor?) -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      /* Clear here too, and this is the one that matters most: the knob is
         the element a finger actually moves, so it is where refraction is
         seen rather than inferred. */
      let effect = UIGlassEffect(style: .clear)
      if let tint { effect.tintColor = tint }
      /* The press and deform the web knob spends a pointer-speed filter and a
         squash curve on. Here the system owns it, and it responds to the
         real touch rather than to a sampled derivative of one. */
      effect.isInteractive = true
      return effect
    }
    return UIBlurEffect(style: .systemMaterial)
  }

  private static func containerEffect() -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      let effect = UIGlassContainerEffect()
      /* What makes two pieces of glass read as one substance rather than two
         stickers: inside this distance they flow together as they move. It is
         the effect the site spends a filter and a displacement map imitating
         and never quite reaches, and here it is a number. The account circle
         and the theme track keep their own shape, fill, and border regardless
         — this only governs how those two behave near each other in motion,
         which is exactly why the site's static, unmerged look still matches. */
      effect.spacing = 12
      return effect
    }
    return UIBlurEffect(style: .systemThinMaterial)
  }

  // MARK: - Theme colours

  /// One frosted-glass colour, as the site's inspector reports it: an sRGB
  /// triple out of 255 plus the alpha the glass is left to show through,
  /// rather than the 0-1 components UIColor itself expects.
  private static func rgba(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat) -> UIColor {
    UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: a)
  }

  /// Every colour a theme touches, gathered in one place so applyTheme() is a
  /// list of assignments rather than three copies of the same nine values.
  private struct ThemeColors {
    let barFill: UIColor
    let divider: UIColor
    let trackFill: UIColor
    let trackBorder: UIColor
    let accountFill: UIColor
    let accountBorder: UIColor
    let iconTint: UIColor
    let foreground: UIColor
    let knobFill: UIColor
    let knobBorder: UIColor?
  }

  private static let themeColors: [String: ThemeColors] = [
    "warm": ThemeColors(
      barFill: rgba(255, 255, 255, 0.08),
      divider: rgba(255, 255, 255, 0.463),
      trackFill: rgba(244, 238, 231, 0.48),
      trackBorder: rgba(162, 150, 138, 0.24),
      accountFill: rgba(255, 255, 255, 0.08),
      accountBorder: rgba(255, 255, 255, 0.314),
      iconTint: rgba(169, 93, 47, 1),
      foreground: rgba(42, 37, 33, 1),
      knobFill: rgba(247, 244, 240, 0.97),
      knobBorder: rgba(169, 93, 47, 0.45)
    ),
    "light": ThemeColors(
      barFill: rgba(246, 247, 248, 0.539),
      divider: rgba(221, 225, 230, 0.957),
      trackFill: rgba(22, 23, 26, 0.07),
      trackBorder: rgba(231, 233, 236, 1.0),
      accountFill: rgba(250, 250, 250, 0.147),
      accountBorder: rgba(232, 234, 237, 0.89),
      iconTint: rgba(58, 61, 67, 1),
      foreground: rgba(22, 23, 26, 1),
      knobFill: rgba(252, 252, 253, 0.97),
      knobBorder: rgba(58, 61, 67, 0.38)
    ),
    "dark": ThemeColors(
      barFill: rgba(253, 253, 253, 0.044),
      divider: rgba(245, 247, 248, 0.15),
      trackFill: rgba(255, 255, 255, 0.035),
      trackBorder: rgba(255, 255, 255, 0.114),
      accountFill: rgba(255, 255, 255, 0.045),
      accountBorder: rgba(241, 242, 244, 0.25),
      iconTint: rgba(238, 154, 115, 1),
      foreground: rgba(244, 244, 245, 1),
      knobFill: rgba(92, 88, 86, 0.99),
      knobBorder: rgba(218, 135, 98, 0.42)
    ),
  ]

  // MARK: - Build

  private func build() {
    backgroundColor = .clear

    barEffectView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(barEffectView)
    NSLayoutConstraint.activate([
      barEffectView.leadingAnchor.constraint(equalTo: leadingAnchor),
      barEffectView.trailingAnchor.constraint(equalTo: trailingAnchor),
      barEffectView.topAnchor.constraint(equalTo: topAnchor),
      barEffectView.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])

    let content = barEffectView.contentView

    /* The website makes the logo and wordmark together one link to `/`; this
       is that link's native equivalent, and it has to be one tap target for
       the same reason it is one <a> there rather than two — a mark and a
       word that both go to the same place are one control, not a pair that
       happen to agree. Both become subviews of the button itself, the same
       relationship configure() sets up for a single glyph below, rather
       than a separate transparent view stacked on top of them, so there is
       only ever one thing here for a touch — or VoiceOver — to find.
       isAccessibilityElement is turned off on both explicitly rather than
       left to their defaults, since a UILabel with text is its own
       accessibility element by default and would otherwise still read out
       "BandUp" as a second stop right next to the button announcing it. */
    homeButton.translatesAutoresizingMaskIntoConstraints = false
    homeButton.accessibilityLabel = "BandUp, home"
    homeButton.accessibilityTraits = .button
    homeButton.addTarget(self, action: #selector(homeTapped), for: .touchUpInside)
    /* Its own press state, manufactured rather than inherited: the glyph
       buttons below get theirs for free because a `.system` button dims
       whatever it manages through setImage/setTitle, but logoView and
       wordmark are plain subviews added by hand, which that dimming does
       not reach. Fading the button itself instead of each child means both
       fade together as the one surface they are meant to read as. */
    homeButton.addTarget(self, action: #selector(homePressBegan), for: [.touchDown, .touchDragEnter])
    homeButton.addTarget(
      self, action: #selector(homePressEnded),
      for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit]
    )
    content.addSubview(homeButton)

    /* A dedicated image set rather than the app icon. An icon in an
       AppIcon.appiconset is not an ordinary named image — UIImage(named:)
       does not reliably resolve it, and the bar would have shown a blank
       square. BandUpMark holds the same artwork at the three sizes a 32pt
       view actually needs, instead of decoding a 1024px icon to draw it. */
    logoView.image = UIImage(named: "BandUpMark")
    logoView.contentMode = .scaleAspectFill
    logoView.clipsToBounds = true
    logoView.layer.cornerRadius = 16
    logoView.layer.cornerCurve = .continuous
    logoView.isAccessibilityElement = false
    logoView.translatesAutoresizingMaskIntoConstraints = false
    homeButton.addSubview(logoView)

    wordmark.text = "BandUp"
    wordmark.font = .systemFont(ofSize: 17, weight: .semibold)
    wordmark.adjustsFontForContentSizeCategory = true
    wordmark.isAccessibilityElement = false
    wordmark.translatesAutoresizingMaskIntoConstraints = false
    homeButton.addSubview(wordmark)

    /* A bare glyph, same as the site: the menu button has no surface behind
       it there, so it does not get one here either. Inventing glass for a
       control the site does not give any is the same drift as leaving glass
       off a control the site does have — either way the two stop matching. */
    configure(menuButton, asset: "IconMenu", size: 22, label: "Open menu")
    menuButton.addTarget(self, action: #selector(menuTapped), for: .touchUpInside)
    menuButton.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(menuButton)

    accountEffectView.translatesAutoresizingMaskIntoConstraints = false
    if #available(iOS 26.0, *) {
      accountEffectView.cornerConfiguration = .capsule()
    } else {
      accountEffectView.layer.cornerRadius = NativeChromeView.accountSize / 2
    }
    accountEffectView.layer.cornerCurve = .continuous
    accountEffectView.clipsToBounds = true
    accountEffectView.layer.borderWidth = 1

    configure(accountButton, asset: "IconAccount", size: 20, label: "Your account")
    accountButton.addTarget(self, action: #selector(accountTapped), for: .touchUpInside)
    accountButton.translatesAutoresizingMaskIntoConstraints = false
    accountEffectView.contentView.addSubview(accountButton)

    buildThemeControl()

    /* The 10pt gap between the two pills, and nothing else — this stack has
       no material of its own, unlike containerEffectView below it. */
    let group = UIStackView(arrangedSubviews: [accountEffectView, themeTrack])
    group.axis = .horizontal
    group.spacing = 10
    group.alignment = .center
    group.translatesAutoresizingMaskIntoConstraints = false

    containerEffectView.translatesAutoresizingMaskIntoConstraints = false
    containerEffectView.contentView.addSubview(group)
    content.addSubview(containerEffectView)

    /* The hairline the web draws between the header and the page. Without
       it the bar's glass just stops, and the seam between native and web
       content is exactly where the eye lands. */
    divider.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(divider)

    /*
      Everything is centred on the bar's bottom strip rather than on the bar.

      The glass deliberately runs the full height, up under the status bar, so
      that the clock and the signal bars sit on the same material as the rest
      of the bar. Centring the controls in that whole height then pushes them
      up into it — the wordmark collided with the carrier label and the time,
      which is exactly what the first run on the simulator showed. The strip
      below the safe area is the part meant to hold controls, so that is what
      they are centred in.
    */
    let centreY = NativeChromeView.barContentHeight / 2

    NSLayoutConstraint.activate([
      /* homeButton's own frame is independent — leading, centreY and a fixed
         height matching the logo, the tallest of the two things inside it.
         Its trailing edge is instead pinned to wordmark's below, the same
         constraint menuButton's leading edge used to read directly, so the
         button's footprint is exactly the union of the logo and the
         wordmark it wraps rather than a number restated. */
      homeButton.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
      homeButton.centerYAnchor.constraint(equalTo: content.bottomAnchor, constant: -centreY),
      homeButton.heightAnchor.constraint(equalToConstant: 32),

      logoView.leadingAnchor.constraint(equalTo: homeButton.leadingAnchor),
      logoView.centerYAnchor.constraint(equalTo: homeButton.centerYAnchor),
      logoView.widthAnchor.constraint(equalToConstant: 32),
      logoView.heightAnchor.constraint(equalToConstant: 32),

      wordmark.leadingAnchor.constraint(equalTo: logoView.trailingAnchor, constant: 10),
      wordmark.centerYAnchor.constraint(equalTo: homeButton.centerYAnchor),
      homeButton.trailingAnchor.constraint(equalTo: wordmark.trailingAnchor),

      menuButton.leadingAnchor.constraint(greaterThanOrEqualTo: homeButton.trailingAnchor, constant: 12),
      menuButton.trailingAnchor.constraint(equalTo: containerEffectView.leadingAnchor, constant: -10),
      menuButton.centerYAnchor.constraint(equalTo: content.bottomAnchor, constant: -centreY),
      menuButton.widthAnchor.constraint(equalToConstant: 40),
      menuButton.heightAnchor.constraint(equalToConstant: 40),

      containerEffectView.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),
      containerEffectView.centerYAnchor.constraint(equalTo: content.bottomAnchor, constant: -centreY),

      group.leadingAnchor.constraint(equalTo: containerEffectView.contentView.leadingAnchor),
      group.trailingAnchor.constraint(equalTo: containerEffectView.contentView.trailingAnchor),
      group.topAnchor.constraint(equalTo: containerEffectView.contentView.topAnchor),
      group.bottomAnchor.constraint(equalTo: containerEffectView.contentView.bottomAnchor),

      accountEffectView.widthAnchor.constraint(equalToConstant: NativeChromeView.accountSize),
      accountEffectView.heightAnchor.constraint(equalToConstant: NativeChromeView.accountSize),

      accountButton.leadingAnchor.constraint(equalTo: accountEffectView.contentView.leadingAnchor),
      accountButton.trailingAnchor.constraint(equalTo: accountEffectView.contentView.trailingAnchor),
      accountButton.topAnchor.constraint(equalTo: accountEffectView.contentView.topAnchor),
      accountButton.bottomAnchor.constraint(equalTo: accountEffectView.contentView.bottomAnchor),

      divider.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      divider.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      divider.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      divider.heightAnchor.constraint(equalToConstant: 1),
    ])

    applyTheme(animated: false)
    applyThemeSelection(animated: false)
  }

  /// Every glyph button shares this shape: a plain, non-interactive image
  /// view laid out to an exact size rather than left to
  /// button.setImage(_:for:), which would size it at the asset's own native
  /// point size — the menu glyph's native size and the theme glyphs' both
  /// differ from what the site renders them at, so the size the site
  /// measured is the one Auto Layout is told to hit.
  private func configure(_ button: UIButton, asset: String, size: CGFloat, label: String) {
    /* A miss here — the asset not having made it into the bundle —
       leaves the button glyph-less rather than reaching for a system symbol
       that would not match the site's icon either way; a wrong-looking
       glyph is worse than none. */
    let imageView = UIImageView(image: UIImage(named: asset)?.withRenderingMode(.alwaysTemplate))
    imageView.contentMode = .scaleAspectFit
    imageView.isUserInteractionEnabled = false
    imageView.translatesAutoresizingMaskIntoConstraints = false
    button.addSubview(imageView)
    NSLayoutConstraint.activate([
      imageView.centerXAnchor.constraint(equalTo: button.centerXAnchor),
      imageView.centerYAnchor.constraint(equalTo: button.centerYAnchor),
      imageView.widthAnchor.constraint(equalToConstant: size),
      imageView.heightAnchor.constraint(equalToConstant: size),
    ])
    button.accessibilityLabel = label
  }

  /// Stop size, the gap between stops, and the track's own inset — together
  /// these give the knob's pitch and the track's footprint, so the measured
  /// 110x38 pill falls out of the same numbers rather than being restated.
  private static let stopSize: CGFloat = 34
  private static let stopGap: CGFloat = 2
  private static let trackPadding: CGFloat = 2
  private static var stopPitch: CGFloat { stopSize + stopGap }

  /// How much of the theme's accent the track's surface carries — enough to
  /// give the knob's rim something to bend, and no more. Tuned against the
  /// simulator rather than derived: see applyTheme() for what it is for and
  /// what going too far costs.
  private static let trackTintOpacity: CGFloat = 0.14

  /// The account circle's own diameter, sized directly since nothing but its
  /// glyph sits inside it.
  private static let accountSize: CGFloat = 40

  private func buildThemeControl() {
    themeTrack.translatesAutoresizingMaskIntoConstraints = false
    if #available(iOS 26.0, *) {
      themeTrack.cornerConfiguration = .capsule()
      /*
        Nothing along this chain clips, and that is the whole trick: the knob
        is wider and taller than the track it lives in, so every box between
        it and the bar has to let it through. The glass keeps its capsule
        shape without any clipping because cornerConfiguration tells the
        material what shape to render, rather than a rectangle being cut down
        to one afterwards.

        Below 26 that is not true — the shape there comes from
        layer.cornerRadius, and only clipsToBounds makes a blur honour it — so
        that path keeps clipping and keeps the knob inside the track, at the
        size it has always been. A fallback that does not dome is the point of
        having one; a rectangular blur where a pill should be is not.
      */
      themeTrack.clipsToBounds = false
      themeTrack.contentView.clipsToBounds = false
    } else {
      themeTrack.layer.cornerRadius = NativeChromeView.stopSize / 2 + NativeChromeView.trackPadding
      themeTrack.clipsToBounds = true
    }
    themeTrack.layer.cornerCurve = .continuous

    /* Pinned to fill the track and added before anything else, so it is the
       bottom-most thing in it and the knob rides over it. It never takes a
       touch: it is the track's own surface, and the gesture recogniser that
       cares about touches there is on themeTrack itself. */
    trackOutline.translatesAutoresizingMaskIntoConstraints = false
    trackOutline.isUserInteractionEnabled = false
    if #available(iOS 26.0, *) {
      trackOutline.cornerConfiguration = .capsule()
    } else {
      trackOutline.layer.cornerRadius = NativeChromeView.stopSize / 2 + NativeChromeView.trackPadding
    }
    trackOutline.layer.cornerCurve = .continuous
    trackOutline.layer.borderWidth = 1
    themeTrack.contentView.addSubview(trackOutline)

    themeStack.axis = .horizontal
    themeStack.spacing = NativeChromeView.stopGap
    themeStack.alignment = .center
    themeStack.translatesAutoresizingMaskIntoConstraints = false

    /* The knob goes in after the track's surface and before the glyphs, which
       is the only band in the stacking order that works: over the outline, so
       the circle breaks it the way a thick lens laid on a drawn line does,
       and under the icons, because the web control spent a long time learning
       that a label read through frosted glass is a smear and the same is true
       here. Both halves of that matter now that the knob is wider than a
       stop: it overlaps its neighbour's button by a few points, and only this
       ordering keeps that neighbour's glyph crisp. It is
       interactive despite that — isInteractive on its UIGlassEffect is what
       gives it Apple's own press-and-refract, and that only fires for a
       touch the knob view itself actually receives. Sitting under the stop
       buttons would normally cost it every touch at its own position to
       whichever button is on top there; hitTest(_:with:) below is what gets
       it back without moving the knob in front and smearing that stop's
       glyph, which is the thing this ordering was chosen to avoid. */
    knob.translatesAutoresizingMaskIntoConstraints = false
    knob.isUserInteractionEnabled = true
    /*
      Apple's own corner shape, not a radius we maintain.

      UICornerConfiguration.capsule() scales with the view, so a knob that
      grows under a finger stays a perfect circle for every frame of the
      swell. Doing it by hand meant setting cornerRadius to half the resting
      width and then animating it alongside the size — and the frame the two
      disagreed on is exactly where the rim stops reading as a drop of water
      and starts reading as a smear. Pre-26 keeps the manual radius, which is
      correct there because the knob does not grow on that path anyway.
    */
    if #available(iOS 26.0, *) {
      knob.cornerConfiguration = .capsule()
    } else {
      knob.layer.cornerRadius = NativeChromeView.knobRestingSize / 2
    }
    knob.layer.cornerCurve = .continuous
    knob.clipsToBounds = true
    themeTrack.contentView.addSubview(knob)
    themeTrack.contentView.addSubview(themeStack)

    let leading = knob.leadingAnchor.constraint(
      equalTo: themeTrack.contentView.leadingAnchor,
      constant: NativeChromeView.knobLeading(atStop: 0)
    )
    let width = knob.widthAnchor.constraint(equalToConstant: NativeChromeView.knobRestingSize)
    let height = knob.heightAnchor.constraint(equalToConstant: NativeChromeView.knobRestingSize)
    knobLeading = leading
    knobWidth = width
    knobHeight = height
    NSLayoutConstraint.activate([
      leading,
      knob.centerYAnchor.constraint(equalTo: themeTrack.contentView.centerYAnchor),
      width,
      height,

      trackOutline.leadingAnchor.constraint(equalTo: themeTrack.contentView.leadingAnchor),
      trackOutline.trailingAnchor.constraint(equalTo: themeTrack.contentView.trailingAnchor),
      trackOutline.topAnchor.constraint(equalTo: themeTrack.contentView.topAnchor),
      trackOutline.bottomAnchor.constraint(equalTo: themeTrack.contentView.bottomAnchor),

      themeStack.leadingAnchor.constraint(equalTo: themeTrack.contentView.leadingAnchor, constant: NativeChromeView.trackPadding),
      themeStack.trailingAnchor.constraint(equalTo: themeTrack.contentView.trailingAnchor, constant: -NativeChromeView.trackPadding),
      themeStack.topAnchor.constraint(equalTo: themeTrack.contentView.topAnchor, constant: NativeChromeView.trackPadding),
      themeStack.bottomAnchor.constraint(equalTo: themeTrack.contentView.bottomAnchor, constant: -NativeChromeView.trackPadding),
    ])

    for (index, asset) in NativeChromeView.themeAssets.enumerated() {
      let button = UIButton(type: .system)
      configure(button, asset: asset, size: 20, label: NativeChromeView.themeLabels[index])
      button.tag = index
      button.addTarget(self, action: #selector(themeTapped(_:)), for: .touchUpInside)
      button.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([
        button.widthAnchor.constraint(equalToConstant: NativeChromeView.stopSize),
        button.heightAnchor.constraint(equalToConstant: NativeChromeView.stopSize),
      ])
      themeButtons.append(button)
      themeStack.addArrangedSubview(button)
    }

    installKnobGesture()
  }

  /*
    A touch that hit-tests to the currently selected stop's button is handed
    to the knob instead, so the glass underneath gets the touch its own
    isInteractive effect needs — see the comment above knob's construction
    in buildThemeControl() for why the knob cannot simply move in front to
    get the same result. Every other touch in the bar, including the other
    two stop buttons, passes through untouched: this only ever compares the
    ordinary hit-test result against one specific button and only overrides
    it when that button is the one the knob is currently sitting under.
    Nothing here changes the button's own isUserInteractionEnabled or
    isEnabled, so it stays a normal, focusable control for anything that
    inspects it rather than routes a touch through it.
  */
  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let hit = super.hitTest(point, with: event)
    guard let selected = selectedThemeButton, hit == selected else { return hit }
    let knobPoint = convert(point, to: knob)
    return knob.bounds.contains(knobPoint) ? knob : hit
  }

  private var selectedThemeButton: UIButton? {
    guard let index = NativeChromeView.themes.firstIndex(of: selectedTheme) else { return nil }
    return themeButtons.indices.contains(index) ? themeButtons[index] : nil
  }

  // MARK: - Selection

  /// Called by the web app when the theme changes there, so the two agree.
  func setTheme(_ theme: String, animated: Bool = true) {
    guard NativeChromeView.themes.contains(theme), theme != selectedTheme else { return }
    selectedTheme = theme
    applyTheme(animated: animated)
    applyThemeSelection(animated: animated)
  }

  /// contentView.backgroundColor is the only place a translucent tint can
  /// live pre-26, since UIBlurEffect carries no colour of its own. On 26 the
  /// tint lives on the glass effect handed to `effect` instead, so this
  /// stays clear there and leaves the glass to carry the colour by itself.
  private func paintFallbackTint(_ view: UIVisualEffectView, _ tint: UIColor) {
    if #available(iOS 26.0, *) {
      view.contentView.backgroundColor = .clear
    } else {
      view.contentView.backgroundColor = tint
    }
  }

  /// Every colour above, read from selectedTheme and pushed onto the views
  /// that carry it — called from build() for the first paint and from
  /// setTheme(_:) for every change after, whether it began with a native tap
  /// or arrived from the web through the plugin.
  private func applyTheme(animated: Bool = true) {
    /* UIGlassEffect (and the systemMaterial fallback below 26) renders
       against the trait collection it resolves in, which by default is the
       OS appearance rather than BandUp's own theme — so switching this app
       to Dark while the device is in Light mode left the glass itself light
       no matter what tint got poured into it. Overriding it here, on self,
       makes every nested effect view inherit the resolved appearance from
       this view rather than from the window.

       This has to happen before the new effects are built just below,
       not after, because the crossfade is live: UIGlassEffect keeps
       rendering both the outgoing and incoming effect for the whole 0.3s,
       not a bitmap snapshot of each. Flip the override first and the
       incoming effect is correct from its first frame, while the outgoing
       one briefly renders under the new appearance as it fades away — a
       minor mismatch on a layer that is leaving anyway. Flip it after and
       the mismatch lands on the layer that stays: the incoming effect
       would spend the whole crossfade in the wrong appearance and then
       snap correct once the override finally lands, which reads as a
       glitch rather than a transition. Warm and Light both resolve here to
       `.light`; only Dark asks for the dark appearance.
    */
    overrideUserInterfaceStyle = selectedTheme == "dark" ? .dark : .light

    let colors = NativeChromeView.themeColors[selectedTheme] ?? NativeChromeView.themeColors["warm"]!

    /* Tint, not fill: each of these gets a freshly built UIGlassEffect with
       the theme's colour already on it, rather than a coloured layer painted
       over the existing one — a layer opaque enough to read as the site's
       fill would be opaque enough to hide the refraction under it, which is
       the entire reason this bar is native rather than more CSS. Reassigning
       `effect` inside the animator is also the only handle UIKit gives you
       on animating a glass or blur change at all, so it does double duty. */
    /*
      Untinted on iOS 26, deliberately, and this is a correction rather than
      an omission.

      These surfaces used to be built with the website's own measured fills
      poured in as tints — and the comment above was right that an opaque fill
      would hide the refraction, while the values handed to it were opaque
      enough to do exactly that. The knob's was 0.99 in Dark and 0.97 in the
      other two: paint, not tint, over the one element that should show the
      material best. The bar read as a flat capsule and the answer to "where
      is the glass" was "underneath, smothered".

      Those numbers are CSS fills whose whole job is to *imitate* glass in a
      browser that cannot render it. Pouring an imitation into the real thing
      can only subtract. So on 26 the material is left to do its own work and
      the theme is carried by the parts that are genuinely BandUp's — the
      border, the icon colour, the wordmark, the divider. The fills survive
      only in paintFallbackTint below, for iOS 25 and earlier, where
      UIBlurEffect has no tint of its own and an imitation is all there is.
    */
    let retint = {
      self.barEffectView.effect = NativeChromeView.barEffect(tint: nil)
      self.accountEffectView.effect = NativeChromeView.pillEffect(tint: nil)
      self.themeTrack.effect = NativeChromeView.pillEffect(tint: nil)
      self.knob.effect = NativeChromeView.knobEffect(tint: nil)
    }
    if animated {
      UIViewPropertyAnimator(duration: 0.3, curve: .easeInOut, animations: retint).startAnimation()
    } else {
      retint()
    }

    paintFallbackTint(barEffectView, colors.barFill)
    paintFallbackTint(accountEffectView, colors.accountFill)
    paintFallbackTint(themeTrack, colors.trackFill)
    paintFallbackTint(knob, colors.knobFill)

    divider.backgroundColor = colors.divider

    accountEffectView.layer.borderColor = colors.accountBorder.cgColor
    trackOutline.layer.borderColor = colors.trackBorder.cgColor

    /*
      A tint on the track's surface, and this is the piece that makes the
      refraction visible rather than merely correct.

      Apple's own Liquid Glass material shots all share one thing: the glass
      sits over a saturated band of colour, and what sells the material is
      watching that band pinch and slide as it passes under the rim. This
      track had no colour in it at all — clear glass over a bar that is itself
      a near-uniform wash — so the knob was bending its backdrop faithfully
      and there was simply nothing in that backdrop to be seen bending. That
      is the honest answer to "where is the refraction": the physics was
      running against a blank wall.

      So the surface underneath carries the theme's own accent, thinned to
      about a seventh. It has to stay far below the glyphs in contrast,
      because it is something for the lens to distort and not a coloured pill
      competing with the icons — if the icons stop reading clearly it is too
      strong. The knob stays untinted on purpose: it is the lens, the track is
      what the lens has to bend, and pouring colour into both would put the
      fill back inside the glass where it was smothering the material before.
    */
    if #available(iOS 26.0, *) {
      trackOutline.backgroundColor =
        colors.iconTint.withAlphaComponent(NativeChromeView.trackTintOpacity)
    } else {
      /* Nothing refracts down here, so a tint whose whole job is to be
         refracted would be a colour change with nothing to show for it. The
         fallback keeps the site's own neutral track instead. */
      trackOutline.backgroundColor = nil
    }

    /*
      Every theme rings the knob now, where the site rings only Dark.

      The site can afford that: it marks the selected stop with a fill that is
      97% opaque, so the shape alone says which one is chosen. Once the fill
      came off — because an opaque fill is exactly what was hiding the glass —
      the selection had nothing left to say it with, and a clear knob on a
      clear track is invisible. A rim in the theme's own accent marks it
      without putting anything back in front of the material.
    */
    knob.layer.borderWidth = colors.knobBorder == nil ? 0 : 1
    knob.layer.borderColor = colors.knobBorder?.cgColor

    accountButton.tintColor = colors.iconTint
    menuButton.tintColor = colors.iconTint
    wordmark.textColor = colors.foreground

    let dimmedTint = colors.iconTint.withAlphaComponent(0.55)
    let selectedIndex = NativeChromeView.themes.firstIndex(of: selectedTheme)
    for (position, button) in themeButtons.enumerated() {
      button.tintColor = position == selectedIndex ? colors.iconTint : dimmedTint
    }
  }

  private func applyThemeSelection(animated: Bool) {
    guard let index = NativeChromeView.themes.firstIndex(of: selectedTheme) else { return }
    knobLeading?.constant = restingKnobLeading

    let move = {
      self.layoutIfNeeded()
      for (position, button) in self.themeButtons.enumerated() {
        button.accessibilityTraits = position == index ? [.button, .selected] : [.button]
      }
    }

    if animated {
      /* A spring rather than a curve. The web control approximates one with a
         cubic-bezier that overshoots by 12%; this is the real thing, and it
         carries the knob's own momentum when a tap lands mid-flight. */
      UIViewPropertyAnimator(duration: 0.44, dampingRatio: 0.72, animations: move).startAnimation()
    } else {
      move()
    }
  }

  // MARK: - Knob drag

  /// How much wider and taller the knob's box gets on each edge while a
  /// finger holds it — 0.4375rem at the site's own 16px root, the same
  /// swell the web control gives its draggable knob. Split across both
  /// edges of both axes, so the box grows about its own centre rather than
  /// leaning right and down the way a raw width/height increase would on
  /// anchors that are pinned by their leading and top edges.
  private static let knobGrowthPerEdge: CGFloat = 3

  /*
    The knob's size at rest and while held.

    46 against a 34pt stop and a 38pt track, which is the measurement that
    matters and the one this whole arrangement exists to allow: the circle is
    8pt larger than the track is tall, so it stands 4pt proud of it top and
    bottom and 4pt past either end. That is what the website's knob does, and
    it is why it reads as a thick lens laid on the track rather than a disc
    dropped into a slot — a circle that fits inside its container has no rim
    to catch light on, because the container's own edge is always there first.

    Below 26 it stays the stop's own size, where the track still clips and a
    46pt knob would only arrive as a clipped stripe. Every offset downstream
    is derived from this number rather than restated, so that path collapses
    back to exactly the geometry it had before any of this: the centring term
    below goes to zero when the knob is one stop wide.

    Growth is the same 3pt an edge either way, deliberately slight — the swell
    should read as the glass thickening under a finger, not as the control
    changing size.
  */
  private static var knobRestingSize: CGFloat {
    if #available(iOS 26.0, *) { return 46 }
    return stopSize
  }
  private static var knobHeldSize: CGFloat { knobRestingSize + knobGrowthPerEdge * 2 }

  /// Where the knob's leading edge belongs for a position along the track,
  /// given in the same continuous stop index stopFraction(forTrackX:) yields
  /// — whole numbers land on stops, anything between them is a drag in
  /// flight. The trailing term is the entire centring correction: a knob
  /// wider than a stop has to be pulled back by half the difference, or it
  /// starts where the stop starts and hangs off the right of it instead of
  /// sitting on it. Everything that positions the knob goes through here, so
  /// there is one copy of that correction and no way to apply it twice.
  private static func knobLeading(atStop fraction: CGFloat) -> CGFloat {
    trackPadding + fraction * stopPitch - (knobRestingSize - stopSize) / 2
  }

  /// How far, in points, a touch has to travel along the track before this
  /// reads as a drag rather than a tap. Below it, whichever stop button the
  /// touch landed on — or, at the selected stop, hitTest(_:with:) standing
  /// in for it — is left to decide on its own; a drag this small is closer
  /// to a hand's natural tremor between touching down and lifting off than
  /// to an intended pull toward another stop.
  private static let knobDragThreshold: CGFloat = 4

  /// The knob's resting leading constant for whatever selectedTheme is
  /// right now — the same formula applyThemeSelection uses, read fresh
  /// rather than cached, because grow and shrink both need it and can be
  /// asked either mid-tap, where selectedTheme has not changed yet, or
  /// right after a drag has just committed a new one.
  private var restingKnobLeading: CGFloat {
    let index = NativeChromeView.themes.firstIndex(of: selectedTheme) ?? 0
    return NativeChromeView.knobLeading(atStop: CGFloat(index))
  }

  /*
    A single long-press recogniser with no minimum duration, rather than the
    separate press-and-pan pair the web's pointer handlers are split across.
    UILongPressGestureRecognizer already reports .changed on every touch move
    once it has begun, which a duration of 0 makes true from the instant a
    finger lands — one recogniser's state machine is what a pan-plus-press
    pairing would otherwise need shared state between the two of to rebuild.

    It lives on themeTrack, not on the knob, because the knob only occupies
    one stop's width at a time and a finger has to be able to land anywhere
    along the track — on a stop nowhere near the current selection — for
    this to feel like a slider rather than a control that only answers where
    it already happens to be. cancelsTouchesInView is off so the stop
    buttons underneath keep receiving their own touches unmolested; see
    handleKnobPress(_:) for how a plain tap is still divided between this
    recogniser and those buttons without either double-firing onTheme or
    leaving a tapped stop dead.
  */
  private func installKnobGesture() {
    let press = UILongPressGestureRecognizer(target: self, action: #selector(handleKnobPress(_:)))
    press.minimumPressDuration = 0
    press.cancelsTouchesInView = false
    themeTrack.addGestureRecognizer(press)
  }

  /// The touch's x within the track, expressed as a continuous version of
  /// the integer stop index applyThemeSelection positions the knob with —
  /// 0 at the first stop's centre, 1 at the second's, and so on, clamped to
  /// the two ends rather than let the knob overshoot the track. Solving the
  /// knobLeading formula backwards for this puts the knob's own centre,
  /// not its leading edge, under the finger, which is the point of reading
  /// a centre-based fraction here instead of the leading-edge x directly.
  private func stopFraction(forTrackX x: CGFloat) -> CGFloat {
    let raw = (x - NativeChromeView.trackPadding - NativeChromeView.stopSize / 2) / NativeChromeView.stopPitch
    return min(max(raw, 0), CGFloat(NativeChromeView.themes.count - 1))
  }

  /// Moves the knob to follow a point during an active drag. No animator —
  /// the constant is set and the layout pass is forced through in the same
  /// frame that reads the touch, which is what makes this track the finger
  /// exactly rather than a beat behind it; an eased catch-up here is exactly
  /// what the web version's own drag handling deliberately avoids.
  private func trackKnob(to point: CGPoint) {
    let fraction = stopFraction(forTrackX: point.x)
    /* The growth offset and the centring offset are different corrections and
       both apply: knobLeading(atStop:) centres the resting box on the stop,
       and the extra step back by one edge's growth keeps the held box centred
       on the same point as the resting one. Because both are subtractions
       about the same centre, the knob's middle stays exactly where
       stopFraction(forTrackX:) put the finger, held or not. */
    knobLeading?.constant =
      NativeChromeView.knobLeading(atStop: fraction) - NativeChromeView.knobGrowthPerEdge
    layoutIfNeeded()
  }

  /// The bloom a held knob gets: width and height widen by the full growth
  /// on each edge, and knobLeading is set to the grown-and-shifted position
  /// in the same animation rather than left for trackKnob(to:) to catch up
  /// to on the next touch move, so the box visibly grows about its centre
  /// even for a press that never turns into a drag at all.
  private func growKnob() {
    let target = restingKnobLeading - NativeChromeView.knobGrowthPerEdge
    UIViewPropertyAnimator(duration: 0.2, dampingRatio: 0.75) {
      self.knobWidth?.constant = NativeChromeView.knobHeldSize
      self.knobHeight?.constant = NativeChromeView.knobHeldSize
      self.knobLeading?.constant = target
      self.layoutIfNeeded()
    }.startAnimation()
  }

  /// The reverse of growKnob(), back to whatever stop is selected at the
  /// moment it runs — called after setTheme(_:) on a committing drag, so by
  /// then selectedTheme already names the stop this should settle onto.
  private func shrinkKnob() {
    let target = restingKnobLeading
    UIViewPropertyAnimator(duration: 0.2, dampingRatio: 0.75) {
      self.knobWidth?.constant = NativeChromeView.knobRestingSize
      self.knobHeight?.constant = NativeChromeView.knobRestingSize
      self.knobLeading?.constant = target
      self.layoutIfNeeded()
    }.startAnimation()
  }

  @objc private func handleKnobPress(_ gesture: UILongPressGestureRecognizer) {
    let point = gesture.location(in: themeTrack.contentView)

    switch gesture.state {
    case .began:
      // Grows in place rather than jumping to the touch first: a tap that
      // never becomes a drag should read as the knob reacting to being
      // held, not as it leaping toward whatever stop happened to catch the
      // finger. trackKnob(to:) only starts moving it once .changed says the
      // finger actually has.
      knobPressOrigin = point
      growKnob()

    case .changed:
      trackKnob(to: point)

    case .ended, .cancelled, .failed:
      defer { knobPressOrigin = nil }
      guard let origin = knobPressOrigin else { return }
      let dragged = abs(point.x - origin.x) > NativeChromeView.knobDragThreshold
      let index = Int(stopFraction(forTrackX: point.x).rounded())
      let landedOnSelected = NativeChromeView.themes[index] == selectedTheme
      /*
        A real drag always commits, to whichever stop it ends nearest —
        including the one it started on, which is still a commit and not a
        no-op cancel. A tap commits here only if it landed on the selected
        stop, because hitTest(_:with:) has routed that one stop's touches to
        the knob and away from its own button, so nothing else is going to
        fire setTheme for it. A tap on either other stop does nothing here
        on purpose: that button still has the touch and is about to fire
        touchUpInside on its own, and calling setTheme a second time for the
        same theme would only mean onTheme reaching the web app twice.
      */
      if dragged || landedOnSelected {
        let theme = NativeChromeView.themes[index]
        setTheme(theme)
        onTheme?(theme)
      }
      shrinkKnob()

    default:
      break
    }
  }

  // MARK: - Actions

  @objc private func homeTapped() { onHome?() }
  @objc private func homePressBegan() {
    UIView.animate(withDuration: 0.15) { self.homeButton.alpha = 0.5 }
  }
  @objc private func homePressEnded() {
    UIView.animate(withDuration: 0.15) { self.homeButton.alpha = 1 }
  }

  @objc private func menuTapped() { onMenu?() }
  @objc private func accountTapped() { onAccount?() }

  @objc private func themeTapped(_ sender: UIButton) {
    let theme = NativeChromeView.themes[sender.tag]
    setTheme(theme)
    onTheme?(theme)
  }
}
