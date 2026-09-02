/* ImageIO for the avatar's thumbnail decode alone — see avatarImage(from:
   scale:) for why a learner's photograph is never decoded at full size. */
import ImageIO
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

  /*
    The sunrise glyph rides 2pt higher than the other two, and the asset is
    not at fault.

    IconThemeWarm draws its horizon low in the box with the arc and rays
    stacked above it, so the ink sits below the centre of the box even though
    the box itself is centred correctly. IconThemeLight is a sun about its own
    middle. Centre two glyphs by their bounding boxes when their content is
    not distributed alike and the eye sees them misaligned, because the eye is
    reading the ink and not the box.

    The website corrects it by the same amount and in the same direction —
    ThemeToggle.tsx gives the warm icon `-translate-y-0.5`, which is 0.125rem
    against a 16px root, so 2px there and 2pt here. Only the warm one moves;
    nudging the other two down would fix the alignment by putting all three in
    the wrong place.
  */
  private static let warmGlyphIndex = 0
  private static let warmGlyphOffsetY: CGFloat = -2

  private let barEffectView: UIVisualEffectView
  /// Wraps the account button and the theme control so their glass can flow
  /// together in motion the way the site's two pills never do on their own —
  /// see containerEffect() below. It carries no fill or border of its own;
  /// everything visible about this pair comes from the two views inside it.
  private let containerEffectView: UIVisualEffectView
  private let menuButton = UIButton(type: .system)
  /// The view Apple's zoom transition grows the navigation list out of, and
  /// unwinds it back into. Exposed as a plain UIView rather than the button
  /// itself so nothing outside can reach in and re-target or re-style it: the
  /// transition needs a rectangle on screen, not a control.
  var menuSourceView: UIView { menuButton }
  /// The account control: a glyph button on a pill of its own, so that on 26
  /// it wears the same surface, fill and outline as the theme track beside it.
  /// It spent a while on UIButton.Configuration.glass() with no wrapper at all,
  /// which is what left the two reading as different materials — see
  /// styleAccountButton(_:) for that whole detour and why it ended.
  private let accountButton = UIButton(type: .system)
  private let accountPill: UIVisualEffectView
  /// The account circle's fill and outline, in a view of its own inside the
  /// pill for the same reason trackOutline is one inside the track: a view
  /// draws its own layer's border after every subview it has, and the glyph
  /// sits on top. Nothing domes over this one, but keeping the two circles
  /// built the same way is what keeps them looking the same.
  private let accountOutline = UIView()
  /*
    The learner's own face, over the account circle, and the reason it is a
    view of its own rather than an image set on the button.

    The website's account control has three states — a photo, an initial, and
    the generic glyph — and only the third of them is a glyph at all. The other
    two fill the whole circle, which means they cover the fill and the border
    that accountOutline draws for the glyph state. So they need a surface with
    the same shape, and it has to draw its own rim after its contents: a view
    paints its layer's border after every subview it has, which is precisely
    why accountOutline and trackOutline exist in the first place, and the same
    trick is what keeps a photograph from swallowing the circle's edge.

    Inside accountButton rather than inside accountOutline, and that placement
    is forced by the pre-26 path. Above 26 the circle's fill and border are on
    accountOutline, underneath the button; below 26 there is no glass and the
    button's own configuration background draws them, which is above
    accountOutline and would paint straight over a photo parented there. The
    button's subviews are above both, on either release.
  */
  private let accountFace = UIView()
  private let accountPhoto = UIImageView()
  private let accountInitialLabel = UILabel()
  /// The generic glyph configure() placed in the account button, kept so the
  /// other two states can hide it. It is covered by an opaque face either way;
  /// hiding it matters for an avatar with an alpha channel, which would
  /// otherwise show a person icon through the learner's own photograph.
  private var accountGlyph: UIImageView?
  /// What the web app last said belongs on the button, and the image fetched
  /// for that exact URL. accountPhotoImage is only ever non-nil while it
  /// belongs to accountAvatarURL — see setAccount(avatarURL:initial:) for why
  /// the two are cleared together rather than separately.
  private var accountAvatarURL: URL?
  private var accountInitial: String?
  private var accountPhotoImage: UIImage?

  /*
    Which theme control is live.

    Apple ships this control. UISegmentedControl on 26 is rendered in Liquid
    Glass by the system: its selected indicator is real glass, it deforms
    under a press, and it has let a finger drag the selection between segments
    since iOS 13 — which is the whole of what the track, the knob, the swell,
    the spring and the hit-test dance below were built by hand to do. Given
    the choice between our reconstruction and the thing it was reconstructing,
    the owner picked Apple's.

    That is a choice only 26 offers, and for a while this flag did not know it.
    It read `true` with no version test under it, so every release ran Apple's
    control — and below 26 Apple's control is not Liquid Glass at all but its
    older appearance: a pale rounded *square* over the selected glyph, with a
    hairline divider ruled between the other two. Seen on 18.5, and it is the
    shape rather than the colour that gives it away, since nothing else in this
    bar has a corner that is not a capsule. There is no styling hook that would
    round that indicator either — before 26 it is not glass and was never meant
    to be reshaped — so the only way to have the right shape down there is to
    draw it, which is what the hand-built track has always been for.

    So the version test lives in the flag itself now, which is where the rest
    of this comment always claimed it was. Everything the two paths share — the
    theme sync, the onTheme callback, the colours — is outside the branch, so
    which one is live changes how the control looks and nothing about what it
    does.

    The reconstruction also stays whole for two reasons that have nothing to do
    with the OS: it is the only one that can stand its knob proud of the track,
    and a reconstruction that took this long to get right is worth being able
    to fall back to.
  */
  private static var useSystemSegmentedControl: Bool {
    if #available(iOS 26.0, *) { return true }
    return false
  }

  /// Apple's control, with our three traced glyphs in it. Built here rather
  /// than in buildThemeControl() only because the items have to exist before
  /// the control does; everything else about it is set up there.
  private let themeSegments = UISegmentedControl(
    items: NativeChromeView.themeAssets.map {
      UIImage(named: $0)?.withRenderingMode(.alwaysTemplate) ?? UIImage()
    }
  )

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
  /// The tint the segments' glyphs are currently drawn in, and every set of
  /// glyphs drawn so far — see applySegmentGlyphs(tint:), which is where both
  /// earn their keep.
  private var segmentGlyphTint: UIColor?
  private var segmentGlyphCache: [UIColor: [UIImage?]] = [:]
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

  /// Readable outside so the navigation list can be built in the theme the
  /// bar is already wearing; only setTheme(_:) below may change it.
  private(set) var selectedTheme = "warm"
  /// Whether the web app's navigation sheet is open — see setNavOpen(_:).
  private var navOpen = false

  override init(frame: CGRect) {
    /* themeColors is a type-level table, so it can be read here safely even
       though self is not yet a valid instance — reading the selectedTheme
       property instead would not be, this early. Whatever it seeds each
       glass surface with is provisional anyway: build() calls applyTheme()
       before the view is ever displayed, and that pass is what actually
       has to be correct. */
    let initial = NativeChromeView.themeColors["warm"]!
    barEffectView = UIVisualEffectView(
      effect: NativeChromeView.barEffect(tint: initial.barFill, navOpen: false)
    )
    containerEffectView = UIVisualEffectView(effect: NativeChromeView.containerEffect())
    themeTrack = UIVisualEffectView(
      effect: NativeChromeView.pillEffect(tint: initial.trackFill, interactive: false)
    )
    accountPill = UIVisualEffectView(
      effect: NativeChromeView.accountPillEffect(tint: initial.accountFill)
    )
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
  private static func barEffect(tint: UIColor?, navOpen: Bool) -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      /*
        .clear while the navigation sheet is open, .regular the rest of the
        time — the same split the website makes with .nav-open-header.

        The reasoning below is about a *page* scrolling under the bar, and it
        is right about that and only about that. An open menu is a different
        surface: it is already dimmed and blurred behind its own sheet, there
        is no live body text passing under the wordmark to collide with, and
        it is precisely the kind of layered thing glass is for. Holding the
        bar opaque over it wastes the one moment there is something worth
        bending. So the constraint below is honoured while it applies and
        lifted when it does not, rather than being paid for permanently.
      */
      if navOpen {
        let effect = UIGlassEffect(style: .clear)
        if let tint { effect.tintColor = tint }
        return effect
      }
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

  /// The account circle and the theme track are the same material with
  /// different temperaments, and `interactive` is the whole of the
  /// difference — see below for why the track does not get it.
  private static func pillEffect(tint: UIColor?, interactive: Bool) -> UIVisualEffect {
    if #available(iOS 26.0, *) {
      /*
        Interactive for the account circle, which is a control a finger
        presses, and deliberately not for the theme track, which is not.

        The track is scenery. The only thing on it that answers a touch is
        the knob, and glass that responds to being pressed responds to every
        touch inside its own bounds — so with this on, pressing the knob made
        the whole pill deform around it and the bar appeared to breathe.
        Nothing about the track is meant to move: not its size, not its fill,
        not its outline. It is the surface the drop travels over and
        distorts, and a surface that flinches whenever the drop is picked up
        is not that surface.
      */
      /*
        .clear, not .regular. The bar above needs .regular because a page
        scrolling under it has to stop being legible before it reaches the
        wordmark. These two are small, bordered, and carry nothing but their
        own glyph, so nothing collides and the clearer material has somewhere
        to show — it is the style meant for glass with content behind it,
        which is what these are.

        .regular was tried here, on the theory that its rim would read as
        thickness. It does render a rim — plainly visible on the navigation
        list's much larger cards — but at 110x38 it is about a pixel, and the
        price is that the material itself brightens: measured on the simulator,
        the knob's separation from the track fell from 23 luminance units to 3,
        which is to say the selected stop stopped being visible at all. Clear
        stays.
      */
      let effect = UIGlassEffect(style: .clear)
      if let tint { effect.tintColor = tint }
      effect.isInteractive = interactive
      return effect
    }
    return UIBlurEffect(style: .systemThinMaterial)
  }

  /*
    The account circle's surface, which is the theme track's with the one
    difference the design already called for: this is a control a finger
    presses, so it is interactive, and the track is scenery, so it is not.

    Nothing at all below 26. There the button's own configuration draws the
    site's circle — fill, border and corner — and a blur behind it would be a
    second disc showing around the first. Returning nil keeps the view in the
    hierarchy so the constraints have one shape on both paths, and keeps the
    older releases pixel-for-pixel what they were.
  */
  private static func accountPillEffect(tint: UIColor?) -> UIVisualEffect? {
    if #available(iOS 26.0, *) {
      return pillEffect(tint: tint, interactive: true)
    }
    return nil
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

  /*
    Nothing at all below 26, and that is a correction found while the
    hand-built track was being put back on 18.

    A glass container paints no surface of its own — it is a rule about how the
    pieces inside it behave near each other, which is why the note on
    containerEffectView says everything visible about the pair comes from the
    two views inside it. The fallback here used to be systemThinMaterial, which
    is a surface, on a view with no corner radius and nothing to clip it. So on
    18.5 the pair sat on a plain light rectangle running from the outside of the
    account circle to the outside of the track, hard corners and all. It is
    plainest in Light, where it reads as a panel someone forgot to round, and it
    was there whichever theme control was live.

    nil for the same reason accountPillEffect returns nil: the view stays in the
    hierarchy so the constraints have one shape on both paths, and it draws
    exactly what 26 draws, which is nothing. The navigation list's own container
    already did this — see its init(), which says in its own words that
    neighbouring blurs do not merge and so there is nothing to stand in with.
    This one was the odd one out.
  */
  private static func containerEffect() -> UIVisualEffect? {
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
    return nil
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
  ///
  /// Visible outside this file because the navigation list presented from the
  /// menu button reads the same table — its icon tint and label colour have to
  /// be the bar's, or the two surfaces are two different apps. It reads it
  /// through colors(for:) below rather than being handed a copy.
  struct ThemeColors {
    /*
      The page's own paper, and the only colour here that is not painted on
      anything this view owns.

      It belongs in this table because it is the colour *behind* the bar, and
      the bar is glass: everything above is a description of how much of that
      paper comes through and in what light. It is read by NativeChromePlugin,
      which paints it onto the web view so the strip beside the status bar has
      the page's colour under it rather than the one Capacitor was configured
      with — see paintPageSubstrate there for what was showing before.

      These are `--color-background` in app/globals.css, theme for theme, which
      is what the page canvas paints and therefore the one value that makes the
      seam invisible. Light's is the blue canvas its body paints rather than the
      white its <html> carries, because the body's is the one that reaches the
      top of the viewport.
    */
    let paper: UIColor
    let barFill: UIColor
    let divider: UIColor
    let trackFill: UIColor
    let trackBorder: UIColor
    let accountFill: UIColor
    let accountBorder: UIColor
    /*
      The initial chip, when a learner has a name but no photograph.

      These are the website's `bg-indigo-100` and `text-indigo-700` read
      literally, theme for theme, out of the token blocks in app/globals.css —
      not sampled off the screen the way the glass corrections above were,
      because nothing about this chip is glass. It is an opaque disc with a
      letter on it, exactly as the browser draws it, and the two values that
      make it are named in the markup.

      They are deliberately not iconTint. That colour is measured off the
      rendered bar and lands on indigo-600 in Warm and on a slate in Light,
      whereas the chip's letter is indigo-700 in all three themes; reusing
      iconTint would be matching the wrong element because it happens to be
      nearby.

      Light's pair is the site's own weak contrast — a pale grey letter on a
      near-white disc — and it is reproduced rather than corrected here for the
      same reason the pre-26 account circle is: this bar exists to be the
      website on a different substrate. If that chip should read more strongly
      it should read more strongly in the browser first, and this table will
      follow it.
    */
    let initialFill: UIColor
    let initialInk: UIColor
    let iconTint: UIColor
    let foreground: UIColor
    let knobFill: UIColor
    let knobBorder: UIColor?
  }

  private static let themeColors: [String: ThemeColors] = [
    "warm": ThemeColors(
      paper: rgba(231, 224, 216, 1),
      barFill: rgba(255, 255, 255, 0.08),
      divider: rgba(255, 255, 255, 0.463),
      trackFill: rgba(244, 238, 231, 0.48),
      trackBorder: rgba(162, 150, 138, 0.24),
      accountFill: rgba(255, 255, 255, 0.08),
      accountBorder: rgba(255, 255, 255, 0.314),
      initialFill: rgba(247, 229, 216, 1),
      initialInk: rgba(139, 74, 38, 1),
      iconTint: rgba(169, 93, 47, 1),
      foreground: rgba(42, 37, 33, 1),
      knobFill: rgba(247, 244, 240, 0.97),
      knobBorder: nil
    ),
    "light": ThemeColors(
      paper: rgba(223, 236, 246, 1),
      barFill: rgba(246, 247, 248, 0.539),
      divider: rgba(221, 225, 230, 0.957),
      trackFill: rgba(22, 23, 26, 0.07),
      trackBorder: rgba(231, 233, 236, 1.0),
      accountFill: rgba(250, 250, 250, 0.147),
      accountBorder: rgba(232, 234, 237, 0.89),
      initialFill: rgba(247, 248, 249, 1),
      initialInk: rgba(174, 181, 189, 1),
      iconTint: rgba(58, 61, 67, 1),
      foreground: rgba(22, 23, 26, 1),
      knobFill: rgba(252, 252, 253, 0.97),
      knobBorder: nil
    ),
    "dark": ThemeColors(
      paper: rgba(17, 17, 19, 1),
      barFill: rgba(253, 253, 253, 0.044),
      divider: rgba(245, 247, 248, 0.15),
      trackFill: rgba(255, 255, 255, 0.035),
      trackBorder: rgba(255, 255, 255, 0.114),
      accountFill: rgba(255, 255, 255, 0.045),
      accountBorder: rgba(241, 242, 244, 0.25),
      initialFill: rgba(46, 29, 21, 1),
      initialInk: rgba(238, 154, 115, 1),
      iconTint: rgba(238, 154, 115, 1),
      foreground: rgba(244, 244, 245, 1),
      knobFill: rgba(92, 88, 86, 0.99),
      knobBorder: rgba(218, 135, 98, 0.42)
    ),
  ]

  /// The theme's colours, with Warm standing in for anything unrecognised —
  /// the one way in for everything inside and outside this file, so an
  /// unknown theme name cannot produce a different fallback in two places.
  static func colors(for theme: String) -> ThemeColors {
    themeColors[theme] ?? themeColors["warm"]!
  }

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
    /*
      A shape for a button that has no surface, which is only worth having
      because of what else reads it.

      This button is the source view Apple's zoom transition grows the
      navigation list out of and shrinks it back into, and a zoom morph takes
      its corner from the source. With nothing set, the source's corner is
      zero and the morph resolves to UIKit's own rounded rectangle — a grey
      rounded *square* passing through the button's frame as the list closes,
      next to an account control that is a capsule. Same shape as the account
      control, from the same `.capsule()` the account pill uses rather than a
      radius restated here, and the two agree in motion as well as at rest.

      Nothing is drawn by this. The button still has no background, no border
      and no configuration — see the note above — so a corner configuration on
      it has nothing of its own to shape and changes not a pixel of the bar
      standing still. It exists purely as the shape the transition reads.
    */
    if #available(iOS 26.0, *) {
      menuButton.cornerConfiguration = .capsule()
    } else {
      menuButton.layer.cornerRadius = NativeChromeView.menuButtonSize / 2
      menuButton.layer.cornerCurve = .continuous
    }
    content.addSubview(menuButton)

    /* The glyph still goes in by hand rather than through the configuration's
       own `image`, and only for one reason: configure() lays it out at the
       exact 20pt the site measured, where a configuration renders the asset
       at whatever size it happens to be. The configuration owns the surface
       and the press; this owns the glyph's size. */
    accountGlyph = configure(accountButton, asset: "IconAccount", size: 20, label: "Your account")
    accountButton.addTarget(self, action: #selector(accountTapped), for: .touchUpInside)
    accountButton.translatesAutoresizingMaskIntoConstraints = false
    /*
      Apple's own pointer hover, which is one property and no code of ours.

      It does nothing on a phone, which has no pointer; on an iPad with a
      trackpad or a mouse the cursor morphs onto this control and lifts it the
      way it does on every system control. A UIPointerInteraction with a hand
      written UIPointerStyle would be the alternative and is deliberately not
      taken — the whole of what was asked for here is the system's behaviour,
      and the default effect a UIButton resolves is that behaviour.

      Not on the menu button, and not on the theme track. The track is scenery
      by design — see pillEffect() for the long version — and a hover that
      deformed it would undo the same reasoning that keeps the knob's press
      from making the bar breathe.
    */
    accountButton.isPointerInteractionEnabled = true

    buildAccountControl()
    buildThemeControl()

    /* The 10pt gap between the two pills, and nothing else — this stack has
       no material of its own, unlike containerEffectView below it. */
    let themeControl: UIView =
      NativeChromeView.useSystemSegmentedControl ? themeSegments : themeTrack
    let group = UIStackView(arrangedSubviews: [accountPill, themeControl])
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
      menuButton.widthAnchor.constraint(equalToConstant: NativeChromeView.menuButtonSize),
      menuButton.heightAnchor.constraint(equalToConstant: NativeChromeView.menuButtonSize),

      containerEffectView.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),
      containerEffectView.centerYAnchor.constraint(equalTo: content.bottomAnchor, constant: -centreY),

      group.leadingAnchor.constraint(equalTo: containerEffectView.contentView.leadingAnchor),
      group.trailingAnchor.constraint(equalTo: containerEffectView.contentView.trailingAnchor),
      group.topAnchor.constraint(equalTo: containerEffectView.contentView.topAnchor),
      group.bottomAnchor.constraint(equalTo: containerEffectView.contentView.bottomAnchor),

      accountPill.widthAnchor.constraint(equalToConstant: NativeChromeView.accountSize),
      accountPill.heightAnchor.constraint(equalToConstant: NativeChromeView.accountSize),

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
  /// Returns the glyph it placed, which only the account button has any use
  /// for — its other two states cover the glyph entirely and need to be able
  /// to hide it. Discardable because the menu and theme buttons are glyphs and
  /// nothing else, and asking three call sites to acknowledge a value they do
  /// not want would be noise.
  @discardableResult
  private func configure(
    _ button: UIButton, asset: String, size: CGFloat, label: String, offsetY: CGFloat = 0
  ) -> UIImageView {
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
      imageView.centerYAnchor.constraint(equalTo: button.centerYAnchor, constant: offsetY),
      imageView.widthAnchor.constraint(equalToConstant: size),
      imageView.heightAnchor.constraint(equalToConstant: size),
    ])
    button.accessibilityLabel = label
    return imageView
  }

  /// Stop size, the gap between stops, and the track's own inset — together
  /// these give the knob's pitch and the track's footprint, so the measured
  /// 110x38 pill falls out of the same numbers rather than being restated.
  private static let stopSize: CGFloat = 34
  private static let stopGap: CGFloat = 2
  private static let trackPadding: CGFloat = 2
  private static var stopPitch: CGFloat { stopSize + stopGap }

  /// The measured 110x38 pill, derived rather than restated. The hand-built
  /// track gets this size from its own stack of stops; the system control has
  /// no stops to be sized by, so it is told the box directly and the bar's
  /// layout stays put whichever of the two is on screen.
  private static var trackWidth: CGFloat {
    stopSize * CGFloat(themes.count) + stopGap * CGFloat(themes.count - 1) + trackPadding * 2
  }
  private static var trackHeight: CGFloat { stopSize + trackPadding * 2 }

  /*
    The system control's width, which is deliberately not the track's.

    UISegmentedControl fills a segment with its selected indicator, so the
    segment's aspect ratio *is* the indicator's shape — there is no styling
    knob for this, only arithmetic. At the track's own 110pt the three
    segments come out 36.7 wide against 38 tall and the indicator renders as a
    31x34 vertical oval. Those are measured off the screen rather than
    reasoned about, and they say Apple insets the indicator by 2pt on every
    side: 38 - 4 = 34 tall, 36.7 - 4 ≈ 31 wide.

    Since the inset is the same on both axes, a square segment is all it takes
    to make the indicator round, and a square segment means the control's
    width is exactly its height times the number of segments. 114 rather than
    110 — four points wider than the hand-built track, which is the price of a
    circle and cheap at that.
  */
  private static var segmentedWidth: CGFloat { trackHeight * CGFloat(themes.count) }

  /// How much of the theme's accent the track's surface carries — enough to
  /// give the knob's rim something to bend, and no more. Tuned against the
  /// simulator rather than derived: see applyTheme() for what it is for and
  /// what going too far costs.
  private static let trackTintOpacity: CGFloat = 0.14

  /// The account circle's own diameter, sized directly since nothing but its
  /// glyph sits inside it.
  private static let accountSize: CGFloat = 40
  /// The menu button's box. It draws no surface at all, so this is only the
  /// tap target — and, below 26, the radius its corner is rounded to for the
  /// zoom transition's sake. See where it is built.
  private static let menuButtonSize: CGFloat = 40

  private func buildAccountControl() {
    accountPill.translatesAutoresizingMaskIntoConstraints = false
    if #available(iOS 26.0, *) {
      accountPill.cornerConfiguration = .capsule()
    } else {
      accountPill.layer.cornerRadius = NativeChromeView.accountSize / 2
    }
    accountPill.layer.cornerCurve = .continuous

    accountOutline.translatesAutoresizingMaskIntoConstraints = false
    accountOutline.isUserInteractionEnabled = false
    if #available(iOS 26.0, *) {
      accountOutline.cornerConfiguration = .capsule()
    } else {
      accountOutline.layer.cornerRadius = NativeChromeView.accountSize / 2
    }
    accountOutline.layer.cornerCurve = .continuous
    accountPill.contentView.addSubview(accountOutline)
    accountPill.contentView.addSubview(accountButton)

    NSLayoutConstraint.activate([
      accountOutline.leadingAnchor.constraint(equalTo: accountPill.contentView.leadingAnchor),
      accountOutline.trailingAnchor.constraint(equalTo: accountPill.contentView.trailingAnchor),
      accountOutline.topAnchor.constraint(equalTo: accountPill.contentView.topAnchor),
      accountOutline.bottomAnchor.constraint(equalTo: accountPill.contentView.bottomAnchor),

      accountButton.leadingAnchor.constraint(equalTo: accountPill.contentView.leadingAnchor),
      accountButton.trailingAnchor.constraint(equalTo: accountPill.contentView.trailingAnchor),
      accountButton.topAnchor.constraint(equalTo: accountPill.contentView.topAnchor),
      accountButton.bottomAnchor.constraint(equalTo: accountPill.contentView.bottomAnchor),
    ])

    buildAccountFace()
  }

  /*
    The photo and the initial, both of which fill the circle.

    Hidden from the start and left that way until the web app says otherwise:
    the bar is built long before anyone knows whether a learner is signed in,
    and a circle that begins as the generic glyph and gains a face is the right
    order of events. The reverse — an empty disc waiting to be filled — is the
    one thing the website never shows.

    A plain radius rather than the `.capsule()` corner configuration its two
    siblings use, and the difference is that this view has to *clip*. A capsule
    configuration describes the shape a control draws itself in; clipping is
    masksToBounds against layer.cornerRadius, and the two are separate
    mechanisms that are only guaranteed to agree if the radius is the one
    actually set. At a fixed 40pt box, half the width is exactly the circle the
    capsule would have produced, so nothing is given up by saying it directly.
  */
  private func buildAccountFace() {
    accountFace.translatesAutoresizingMaskIntoConstraints = false
    accountFace.isUserInteractionEnabled = false
    accountFace.isHidden = true
    accountFace.clipsToBounds = true
    accountFace.layer.cornerRadius = NativeChromeView.accountSize / 2
    accountFace.layer.cornerCurve = .continuous
    /* The rim the circle would otherwise have lost. Whichever view draws the
       account circle's border for this release — accountOutline on 26, the
       button's own configuration background below it — is underneath a face
       that is opaque across the whole 40pt, so the face has to draw the edge
       itself. styleAccountButton feeds it the same colour that view is using,
       so the three states have one edge between them rather than two that
       drift. */
    accountFace.layer.borderWidth = 1

    /* scaleAspectFill with clipping, never scaleToFill: an avatar is whatever
       shape the learner uploaded, and the one thing a face must not do is
       stretch. Filling and cropping loses the corners of a wide photograph,
       which is what every avatar on the web does and what the website's own
       `object-cover` does three lines away in SiteHeader.tsx. */
    accountPhoto.translatesAutoresizingMaskIntoConstraints = false
    accountPhoto.contentMode = .scaleAspectFill
    accountPhoto.clipsToBounds = true
    accountPhoto.isUserInteractionEnabled = false

    /* 12pt semibold, which is the site's `text-xs font-semibold` at a 16px
       root. Uppercasing happens here rather than being asked of the web side,
       so the native button cannot end up disagreeing with the browser's own
       `uppercase` over a name typed in lower case. */
    accountInitialLabel.translatesAutoresizingMaskIntoConstraints = false
    accountInitialLabel.font = .systemFont(ofSize: 12, weight: .semibold)
    accountInitialLabel.textAlignment = .center
    accountInitialLabel.isUserInteractionEnabled = false

    accountFace.addSubview(accountPhoto)
    accountFace.addSubview(accountInitialLabel)
    accountButton.addSubview(accountFace)

    NSLayoutConstraint.activate([
      accountFace.leadingAnchor.constraint(equalTo: accountButton.leadingAnchor),
      accountFace.trailingAnchor.constraint(equalTo: accountButton.trailingAnchor),
      accountFace.topAnchor.constraint(equalTo: accountButton.topAnchor),
      accountFace.bottomAnchor.constraint(equalTo: accountButton.bottomAnchor),

      accountPhoto.leadingAnchor.constraint(equalTo: accountFace.leadingAnchor),
      accountPhoto.trailingAnchor.constraint(equalTo: accountFace.trailingAnchor),
      accountPhoto.topAnchor.constraint(equalTo: accountFace.topAnchor),
      accountPhoto.bottomAnchor.constraint(equalTo: accountFace.bottomAnchor),

      accountInitialLabel.centerXAnchor.constraint(equalTo: accountFace.centerXAnchor),
      accountInitialLabel.centerYAnchor.constraint(equalTo: accountFace.centerYAnchor),
    ])
  }

  private func buildThemeControl() {
    if NativeChromeView.useSystemSegmentedControl {
      buildSystemThemeControl()
    } else {
      buildHandBuiltThemeControl()
    }
  }

  /*
    Apple's segmented control, set up and then left alone.

    Almost nothing is done to it on purpose. It is given the three glyphs, the
    box the hand-built track occupied so the bar's layout does not move
    underneath it, and the theme's icon colour — and that is the end of it.
    Its material, its corner treatment, its selected indicator and its press
    and drag behaviour are all the system's, because seeing what the system
    actually does with this control is the entire reason it is here. Anything
    we imposed on top of that would be the hand-built control wearing a
    different name.

    The bridge is identical either way: the same setTheme(_:) syncs it and the
    same onTheme fires out of it, so the web app cannot tell which of the two
    is on screen.
  */
  private func buildSystemThemeControl() {
    themeSegments.translatesAutoresizingMaskIntoConstraints = false
    themeSegments.selectedSegmentIndex = 0
    NSLayoutConstraint.activate([
      themeSegments.widthAnchor.constraint(equalToConstant: NativeChromeView.segmentedWidth),
      themeSegments.heightAnchor.constraint(equalToConstant: NativeChromeView.trackHeight),
    ])
  }

  /*
    The segments' glyphs, rebuilt whenever the theme changes.

    Two things force this to be a rebuild rather than a colour assignment.

    The colour is the first. UISegmentedControl draws a template image in its
    own label colour and ignores the control's tintColor entirely — measured,
    not assumed: with template images and tintColor set to the theme's copper,
    the glyphs came out black in every theme. Baking the colour into the image
    with .alwaysOriginal is the way through, and it means a new image per
    theme rather than one image that follows a tint.

    The second is the label. A segment carrying a bare image has nothing for
    VoiceOver to read, and there is no public per-segment label API; a UIAction
    with both a title and an image gives the control an image to show and a
    title to speak, which is the documented behaviour when it has both. So the
    glyph and the spoken name arrive together or not at all, and the action's
    handler doubles as the selection callback — no valueChanged target, so a
    tap has exactly one route in and nothing double-fires.
  */
  private func applySegmentGlyphs(tint: UIColor) {
    /*
      Nothing to do unless the colour actually moved. applyTheme() is the only
      caller and it already runs on real theme changes only, so this is a belt
      on top of a brace — but the belt is cheap and the cost of a needless
      re-image is not, for the reason below.
    */
    guard segmentGlyphTint != tint else { return }
    segmentGlyphTint = tint

    /*
      This whole block is why the glyphs used to jump and shake on a theme tap.

      setAction(_:forSegmentAt:) replaces a segment's content, which
      invalidates the control's layout. Nothing lays it out again immediately —
      it is left pending — and the very next thing a theme change does is
      applyThemeSelection(), which runs layoutIfNeeded() inside a spring
      animator with a damping ratio of 0.72. That animator picks up the pending
      segment layout along with the selection it was meant for, so three glyphs
      that had not moved at all got animated into place with an overshoot,
      twice, once out and once back. That is the shake, and it is entirely a
      side effect of *when* the layout happened rather than of the images.

      Two things fix it and both are here. performWithoutAnimation keeps the
      swap out of any animation the caller is inside, and forcing the layout
      pass in the same breath leaves nothing pending for the spring to find.
      The images themselves are prepared once per theme by tintedGlyphs(_:)
      rather than re-rendered on every change, so a repeat visit to a theme
      does no drawing at all.

      Measured on the simulator rather than judged, by tracking each glyph's
      ink centroid frame by frame through a Warm-to-Light tap. The moon glyph
      is the one that settles it: the selection never goes near it, so it has
      no business moving at all. Before, it travelled 6.84pt — up about six
      points in a single frame, back down over 150ms, past its resting place,
      and back. After, it travels 0.02pt, and 0.04pt across three changes in a
      row. The sunrise and sun glyphs still register a fraction of a point
      while the indicator slides between them, which is the indicator's own
      glass passing under the ink rather than the ink moving.
    */
    let images = tintedGlyphs(tint)
    UIView.performWithoutAnimation {
      for (index, theme) in NativeChromeView.themes.enumerated() {
        let action = UIAction(title: NativeChromeView.themeLabels[index], image: images[index]) {
          [weak self] _ in
          self?.selectTheme(theme)
        }
        themeSegments.setAction(action, forSegmentAt: index)
      }
      /* setContentOffset takes a CGSize here rather than the UIOffset its name
         suggests, and its height is the vertical nudge. It is re-applied with
         every swap because replacing a segment's action replaces its content,
         and the nudge belongs to the content. */
      themeSegments.setContentOffset(
        CGSize(width: 0, height: NativeChromeView.warmGlyphOffsetY),
        forSegmentAt: NativeChromeView.warmGlyphIndex
      )
      themeSegments.layoutIfNeeded()
    }
  }

  /// The three glyphs at one tint, drawn once and kept. Keyed by the colour
  /// rather than by the theme name so a theme that shares another's accent
  /// shares its images too, and so nothing here has to know what a theme is.
  private func tintedGlyphs(_ tint: UIColor) -> [UIImage?] {
    if let cached = segmentGlyphCache[tint] { return cached }
    let images = NativeChromeView.themeAssets.map {
      UIImage(named: $0)?.withTintColor(tint, renderingMode: .alwaysOriginal)
    }
    segmentGlyphCache[tint] = images
    return images
  }

  private func buildHandBuiltThemeControl() {
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
      /*
        Exactly half the track's height, which is what makes this a capsule and
        not merely a rounded box — and the reason the cornerCurve below can be
        left alone even though a continuous curve is the wrong shape for a
        capsule everywhere else.

        A continuous corner never meets the straight side tangentially; it goes
        on bending to the very end. So at a radius past half a side, where
        there is no straight edge left for two of them to blend into, they meet
        each other and the end comes out pointed — which is what the navigation
        list's own pill was doing until it was clamped, and its corner carries
        the measurement. At exactly half a side there is nothing left to get
        wrong: traced down its left edge on 18.5, this track follows the same
        arc as the capsule 26 draws, to within a pixel of antialiasing, whether
        the curve is asked for as continuous or as circular. The knob below is
        the same case, 17 into a 34pt square, and comes out a circle.
      */
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
      configure(
        button, asset: asset, size: 20, label: NativeChromeView.themeLabels[index],
        offsetY: index == NativeChromeView.warmGlyphIndex
          ? NativeChromeView.warmGlyphOffsetY : 0
      )
      button.tag = index
      /* The stop, not the track it sits on. Same reasoning as the account
         button above; on this path the effect lands on the glyph, which is
         drawn over the knob rather than under it, so a hover over the selected
         stop cannot disturb the knob's glass. */
      button.isPointerInteractionEnabled = true
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

  /*
    Called by the web app when the navigation sheet opens or closes.

    The native side cannot work this out for itself: it raises onMenu and the
    web app decides what that means, and the sheet can close half a dozen ways
    the bar never hears about — Escape, the close button, a tap outside, a
    link followed. So the state comes back across the bridge from the one
    place that actually knows it, and the bar follows rather than guesses.
  */
  func setNavOpen(_ open: Bool) {
    guard open != navOpen else { return }
    navOpen = open
    let swap = {
      self.barEffectView.effect =
        NativeChromeView.barEffect(tint: nil, navOpen: self.navOpen)
    }
    /* Eased rather than snapped, and for the same reason applyTheme's retint
       is: UIGlassEffect renders both materials live through the crossfade, so
       this is a real dissolve between two pieces of glass. */
    UIViewPropertyAnimator(duration: 0.3, curve: .easeInOut, animations: swap).startAnimation()
  }

  /// Called by the web app when the theme changes there, so the two agree.
  func setTheme(_ theme: String, animated: Bool = true) {
    guard NativeChromeView.themes.contains(theme), theme != selectedTheme else { return }
    selectedTheme = theme
    applyTheme(animated: animated)
    applyThemeSelection(animated: animated)
  }

  // MARK: - The account button's face

  /*
    Who is signed in, pushed from the web app the way the theme and the menu
    are, and for the same reason all three travel: the native side cannot work
    any of it out for itself. The session lives in the web layer, the profile
    request is made there, and this view has no idea a learner exists.

    Both values arrive together on purpose. A photo that fails to load has to
    fall back to something, and the something is the learner's initial — so the
    initial cannot be a second call that may or may not have happened by the
    time the download fails. One call, one state, and the fallback is already
    in hand before it is needed.

    The photo is dropped the instant its URL changes rather than held until a
    replacement arrives. Holding it would spare a brief flash of the initial
    when the profile is re-fetched and the signed URL rotates — those URLs are
    one-hour grants, so a long session rotates them — but it would also be the
    mechanism by which one account's face could survive into another's session.
    A flash of the right learner's own initial is a fair price for that not
    being possible, and signing out clears it either way: the web app pushes a
    URL of nil and an initial of nil together, which is the third state.
  */
  func setAccount(avatarURL: URL?, initial: String?) {
    /* First grapheme rather than first byte, so an accented or non-Latin name
       yields a whole character. Uppercased here so the button agrees with the
       browser's `uppercase` on a name typed in lower case. */
    accountInitial = initial
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .flatMap(\.first)
      .map { String($0).uppercased() }

    if avatarURL != accountAvatarURL {
      accountAvatarURL = avatarURL
      accountPhotoImage = nil
      if let avatarURL { loadAvatar(avatarURL) }
    }
    renderAccountFace()
  }

  /*
    The three states, in the website's own order of preference: a photograph
    if there is one, the learner's initial if there is a name or an email, and
    the generic glyph otherwise — signed out, still loading, or a photo that
    has not arrived or never will.

    Called on every theme change as well as on every account change, because
    the initial chip and the circle's rim are both theme colours. Reading the
    stored state rather than being handed it means the two callers cannot
    disagree about what is on screen.
  */
  private func renderAccountFace() {
    let colors = NativeChromeView.colors(for: selectedTheme)
    let photo = accountPhotoImage
    let initial = accountInitial

    accountPhoto.image = photo
    accountPhoto.isHidden = photo == nil
    accountInitialLabel.text = initial
    accountInitialLabel.textColor = colors.initialInk
    accountInitialLabel.isHidden = photo != nil || initial == nil

    /* Nothing behind a photograph — it is opaque and fills the circle, and a
       fill under it would only show through an avatar that carries an alpha
       channel, where the glass behind is the better thing to see. */
    accountFace.backgroundColor = photo == nil ? colors.initialFill : nil
    accountFace.layer.borderColor = accountRimColor(colors).cgColor
    accountFace.isHidden = photo == nil && initial == nil
    accountGlyph?.isHidden = !accountFace.isHidden
  }

  /// The colour the account circle's edge is drawn in, from whichever view is
  /// drawing the circle on this release — see styleAccountButton(_:), which
  /// splits the same way and for the same reason.
  private func accountRimColor(_ colors: ThemeColors) -> UIColor {
    if #available(iOS 26.0, *) { return colors.trackBorder }
    return colors.accountBorder
  }

  /*
    Decoded avatars, kept so the bar is not made to download one twice.

    Small on purpose. A learner has one face, and the only reason for more than
    one entry is a URL rotating while the previous image is still worth having.
    An NSCache rather than a dictionary because the entries are images and this
    is a top bar: under memory pressure the right thing for it to do is give
    them back and fetch again later.

    Keyed by the whole URL, which is worth saying plainly because it is a
    weaker key than it looks. BandUp's avatar URLs are one-hour signed grants —
    see lib/cloudflare/avatar-delivery.ts — so the same photograph has a
    different URL after every profile fetch and lands here as a miss. That is
    the honest behaviour for a capability URL rather than a defect in the
    cache: a rotated grant is a new permission to fetch, and re-fetching is
    what checking it means. What this does buy is everything that re-pushes an
    unchanged URL — a bar rebuilt after disable/enable, the same payload
    arriving twice — and between it and the web side only pushing on a real
    change, a theme switch or a rotation never reaches the network at all.
  */
  private static let avatarCache: NSCache<NSURL, UIImage> = {
    let cache = NSCache<NSURL, UIImage>()
    cache.countLimit = 4
    return cache
  }()

  /*
    Fetching a face, which must never be something the bar waits for.

    All of it is off the main thread and none of it blocks a thing: the bar has
    already drawn the initial or the glyph by the time this starts, and the
    photograph replaces it whenever it lands. A bar that waited for a network
    round trip before appearing would be worse than one that shows a letter for
    a moment.

    No Referer, and no cookies. The website's own <img> carries
    referrerPolicy="no-referrer", and the intent behind it is that fetching a
    face tells the host nothing about the learner beyond the grant it has to
    present anyway. URLSession sends no Referer unless one is set, so matching
    that intent is a matter of not adding one; cookies it would otherwise
    attach from the shared store, and the delivery route neither reads nor
    needs them.

    Every way this can fail ends in the same place. A 404, a 403 on an expired
    grant, no network, a body that is not an image, an image that will not
    decode: each leaves accountPhotoImage nil and the button showing the
    initial or the glyph. There is no state in which it shows a broken image or
    an empty circle, because the only thing that ever fills the circle is an
    image that has already decoded.

    The staleness check on the way back is what makes signing out safe. A fetch
    in flight when the account changes resolves against an accountAvatarURL
    that has moved on, and is dropped rather than painted — so a face cannot
    arrive after the learner it belongs to has gone.
  */
  private func loadAvatar(_ url: URL) {
    if let cached = NativeChromeView.avatarCache.object(forKey: url as NSURL) {
      accountPhotoImage = cached
      return
    }

    var request = URLRequest(url: url)
    request.httpShouldHandleCookies = false
    /* Read on the main thread, where this always is, rather than reached for
       from the completion handler — traitCollection belongs to the view.
       UITraitCollection.current stands behind it for the one case the view's
       own traits are unspecified, which is a bar that has been given an
       account before it was ever put in a window: NativeChromePlugin restores
       the stored face while it builds the view, so that path is real. */
    let scale = max(traitCollection.displayScale, UITraitCollection.current.displayScale, 1)

    URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let image = (200..<300).contains(status)
        ? data.flatMap { NativeChromeView.avatarImage(from: $0, scale: scale) }
        : nil
      guard let image else { return }
      DispatchQueue.main.async {
        guard let self, self.accountAvatarURL == url else { return }
        NativeChromeView.avatarCache.setObject(image, forKey: url as NSURL)
        self.accountPhotoImage = image
        self.renderAccountFace()
      }
    }.resume()
  }

  /*
    Decoded straight to the size the circle needs, rather than decoded whole
    and scaled down by the image view.

    A learner's upload is whatever their phone's camera produced, and a twelve
    megapixel photograph decodes to about 48MB of bitmap however small the view
    showing it is. ImageIO's thumbnail path never materialises that: it reads
    the source's own dimensions, decodes once at the requested size, and gives
    back a bitmap measured in kilobytes.

    The cap is twice the circle so an off-square photograph still has pixels to
    spare on its short axis after scaleAspectFill has cropped it — the limit
    governs the longer side, and a wide photograph filling a circle is scaled
    by its shorter one. Twice 40pt at 3x is 240px, which is a quarter of a
    megabyte at worst and sharp on any screen Apple ships.

    kCGImageSourceShouldCache is off for the source and on for the thumbnail:
    the full-size decode is the thing not worth keeping, and the small one is
    the thing being asked for, decoded here on this background thread rather
    than lazily on the main one at first draw. The transform is applied so a
    photograph taken sideways is not shown sideways.
  */
  private static func avatarImage(from data: Data, scale: CGFloat) -> UIImage? {
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else { return nil }
    let maxPixel = Int((accountSize * scale * 2).rounded(.up))
    let options = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
    ] as CFDictionary
    guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
    return UIImage(cgImage: thumbnail, scale: scale, orientation: .up)
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

    let colors = NativeChromeView.colors(for: selectedTheme)

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
      can only subtract. So on 26 the three large surfaces are left to do their
      own work and the theme is carried by the parts that are genuinely
      BandUp's — the outline, the icon colour, the wordmark, the divider. The
      fills survive only in paintFallbackTint below, for iOS 25 and earlier,
      where UIBlurEffect has no tint of its own and an imitation is all there
      is.

      The knob is the exception, and only since it turned out that stripping
      its fill altogether traded one wrong reading for another — see
      knobRestingAlpha for what half opacity buys that neither 0.97 nor
      nothing could. It is the one surface here small enough that a tint reads
      as the glass being thicker rather than as the glass being covered up.
    */
    let retint = {
      /* navOpen is read here as well as in setNavOpen(_:), because a theme
         change while the menu is open would otherwise rebuild this effect
         from the default and quietly put the bar back to .regular. */
      self.barEffectView.effect =
        NativeChromeView.barEffect(tint: nil, navOpen: self.navOpen)
      self.themeTrack.effect =
        NativeChromeView.pillEffect(tint: nil, interactive: false)
      self.accountPill.effect = NativeChromeView.accountPillEffect(tint: nil)
      self.knob.effect = NativeChromeView.knobEffect(
        tint: self.knobTint(alpha: NativeChromeView.knobRestingAlpha)
      )
    }
    if animated {
      UIViewPropertyAnimator(duration: 0.3, curve: .easeInOut, animations: retint).startAnimation()
    } else {
      retint()
    }

    paintFallbackTint(barEffectView, colors.barFill)
    paintFallbackTint(themeTrack, colors.trackFill)
    /* Not paintFallbackTint: below 26 accountPill has no effect at all and its
       contentView is a plain square, so a fill there would be a square behind
       the site's circle. The circle down there is the button's own, and
       styleAccountButton draws it. */
    paintFallbackTint(knob, colors.knobFill)

    divider.backgroundColor = colors.divider

    styleAccountButton(colors)
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
      strong. It is also set once here per theme and then left entirely alone:
      nothing in the press, the drag or the release touches the track's fill,
      size, outline or effect. It is a still surface for the drop to distort,
      and a surface that moves with the drop distorts nothing.

      The knob's own tint is what thins to almost nothing while it is held, so
      at the moment the drop is travelling across this colour it is at its
      clearest and the distortion has the most to work with.
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
      Only Dark rings the knob, which is where the site rings it too.

      There was a stretch where every theme did. That ring was standing in for
      the fill: with the knob stripped to clear glass the selection had
      nothing left to announce itself with, and a clear circle on a clear
      track is invisible, so an accent rim was doing the marking on its own.
      Now that the fill is back at half strength the disc says which stop is
      chosen by being visibly lighter than the track, exactly as it does on
      the site, and a rim in every theme is one marker too many. Dark keeps
      its because Dark's own knob colour is a grey barely separable from the
      bar behind it, which is precisely why the site draws a border there and
      nowhere else.
    */
    knob.layer.borderWidth = colors.knobBorder == nil ? 0 : 1
    knob.layer.borderColor = colors.knobBorder?.cgColor

    menuButton.tintColor = colors.iconTint
    wordmark.textColor = colors.foreground

    /* The one thing the system control is told about the theme. Everything
       else it draws — the capsule, the material, the selected indicator — is
       Apple's and stays Apple's. */
    applySegmentGlyphs(tint: colors.iconTint)

    let dimmedTint = colors.iconTint.withAlphaComponent(0.55)
    let selectedIndex = NativeChromeView.themes.firstIndex(of: selectedTheme)
    for (position, button) in themeButtons.enumerated() {
      button.tintColor = position == selectedIndex ? colors.iconTint : dimmedTint
    }
  }

  /*
    The account control's surface, and the story of it going away and coming
    back.

    It began as this button inside a UIVisualEffectView we gave a capsule
    corner, a 1pt border and a per-theme fill. Configuration.glass() replaced
    all of it, on the reasoning that the glass, the corner treatment and the
    press behaviour then arrived together and none of the three was ours to
    maintain — and measured against a plain UIGlassEffect wrapper at the time,
    the disc's interior came out the same rgb(240,237,231) either way, so the
    version with no code of its own won.

    What that measurement did not cover is the thing next to it. The comment on
    pillEffect() says the account circle and the theme track are the same
    material with different temperaments; a glass *button* configuration is not
    that material, and it carries neither the track's tint nor its outline. So
    the two sat side by side in one container reading as two different
    substances, which is what the owner saw.

    The wrapper is back, and it costs nothing the configuration was buying:
    isInteractive on a UIGlassEffect is the press response, and interactive is
    exactly the difference the design already asked for between a circle that
    is pressed and a track that is not. The fill and the outline are
    trackOutline's, to the same values, so the pair matches by sharing numbers
    rather than by being tuned to look alike.

    Below 26 nothing here changed. There is no glass configuration to have and
    no glass to wrap, so the button's own background draws the site's circle —
    accountFill and accountBorder, which is why those two colours are still in
    the table — and accountPillEffect returns nil so nothing sits behind it.
  */
  private func styleAccountButton(_ colors: ThemeColors) {
    var config = UIButton.Configuration.plain()
    if #available(iOS 26.0, *) {
      accountOutline.backgroundColor = NativeChromeView.accountFillCorrection(selectedTheme)
      accountOutline.layer.borderColor = colors.trackBorder.cgColor
      accountOutline.layer.borderWidth = 1
    } else {
      config.background.backgroundColor = colors.accountFill
      config.background.strokeColor = colors.accountBorder
      config.background.strokeWidth = 1
      config.background.cornerRadius = NativeChromeView.accountSize / 2
    }
    /* The glyph is a subview configure() placed at the measured 20pt, not the
       configuration's own image, so the configuration is told to claim no
       space for content of its own. */
    config.contentInsets = .zero
    accountButton.configuration = config
    accountButton.tintColor = colors.iconTint
    /* And the other two states of the same button. The glyph is the only one
       of the three the code above draws for; the initial chip and the
       photograph's rim are theme colours too, and this is the one place a
       theme change reaches the account control. */
    renderAccountFace()
  }

  /*
    The neutral that lands the account circle on the theme control beside it,
    and it is a measurement rather than a colour with a meaning.

    The obvious thing was to give this circle trackOutline's own fill — the
    theme's accent at trackTintOpacity — since the two are meant to be one
    material. That fill is not what is on screen next to it. Everywhere this
    function is reached useSystemSegmentedControl is true, so the control
    beside this is Apple's UISegmentedControl and the hand-built track that
    trackOutline belongs to is not rendered at all; matching the code's intent
    would have matched something invisible. Do it anyway and the circle comes
    out visibly copper against a neutral track, which is exactly what the owner
    reported.

    So it is matched to what Apple draws, sampled off the simulator with the
    same page behind both. Untinted, the circle's clear glass and the
    segmented control's own material do not land in the same place:

      theme   circle (clear glass)   segmented track     correction
      warm    rgb(236, 233, 226)     rgb(228, 224, 220)  black  3.5%
      light   rgb(235, 242, 247)     rgb(223, 231, 237)  black  4.7%
      dark    rgb( 31,  32,  34)     rgb( 49,  49,  54)  white  8.0%

    Small numbers, and neutral ones, which is the point: the circle is the same
    glass as before and this only closes the gap between two Apple materials.

    This used to end by saying that flipping useSystemSegmentedControl back
    should put the circle on trackOutline's fill instead. That flag is a
    version test now, and the two ends of it can no longer meet: nothing here
    is reached except from the iOS 26 branch of styleAccountButton, and 26 is
    precisely where the flag is true, so whenever this colour is asked for the
    thing beside the circle is Apple's control. Below 26 neither half of that
    old note applies. There is no glass to correct, and the other branch of
    styleAccountButton draws the site's own circle from accountFill and
    accountBorder — which is the right neighbour for the site's own track,
    even though the two do not match, because they do not match on the website
    either. The track is `.theme-toggle-base`, surface at 48% inside a slate
    border at 24%; the circle is `.premade-glass` inside the default border.
    Two rules, two sets of numbers, and this path exists to reproduce the site
    rather than to improve on it.
  */
  private static func accountFillCorrection(_ theme: String) -> UIColor {
    switch theme {
    case "dark": return UIColor(white: 1, alpha: 0.08)
    case "light": return UIColor(white: 0, alpha: 0.047)
    default: return UIColor(white: 0, alpha: 0.035)
    }
  }

  /*
    Both controls are told the selection, whichever one was built.

    That is deliberate rather than an oversight, and worth saying now that
    useSystemSegmentedControl has two live branches for the first time. On
    either path the control that was not built is inert here: themeSegments
    with no superview and no constraints lays nothing out when its selection is
    set, and fires no action either, since setting selectedSegmentIndex in code
    never does; knobLeading is nil when the hand-built track was skipped, so the
    optional chain resolves to nothing and themeButtons is empty for the loop
    below. Same for the glyph rebuild in applyTheme(), which prepares three
    images per accent colour and keeps them — a few kilobytes for a control
    that may never be shown, against a branch on every theme change.

    Guarding each of these on the flag would buy a skipped assignment and cost
    the thing that makes this bridge trustworthy: one path in, so a theme
    arriving from the web app cannot land on a control the native side forgot
    to keep in step.
  */
  private func applyThemeSelection(animated: Bool) {
    guard let index = NativeChromeView.themes.firstIndex(of: selectedTheme) else { return }
    /* Setting this programmatically does not fire the segments' actions, so a
       theme arriving from the web app syncs the control without bouncing
       straight back out through onTheme. */
    themeSegments.selectedSegmentIndex = index
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

  /*
    How much colour the knob carries at rest, and how little while it is held.

    This is the correction to a correction. The site's own fill is 0.97, and
    pouring that into a UIGlassEffect smothered it — the knob became paint and
    the material underneath had nothing left to show, which is what the long
    comment in applyTheme() is about. The answer taken then was to strip the
    fill entirely, and that overshot in the other direction: with no fill the
    resting knob was a bare ring, when what it is supposed to be is a calm,
    distinctly lighter disc sitting on the selected stop.

    Half opacity is the middle the two ends were circling. It reads as a light
    circle and still lets the glass work. Then the held value is the point of
    the whole arrangement: on press the tint falls away to almost nothing in
    the same animator that swells the box, so the disc turns from a pebble
    into a clear drop exactly as the finger lands on it, and thickens back on
    release. Calm and legible at rest; unmistakably glass the moment it is
    touched — and nothing had to be sacrificed to get both.
  */
  private static let knobRestingAlpha: CGFloat = 0.5
  private static let knobHeldAlpha: CGFloat = 0.15

  /// The knob's tint for the current theme at a given strength. It keeps the
  /// theme's own knob colour and replaces only the alpha, so Dark stays the
  /// grey disc the site paints there rather than turning into a white one.
  private func knobTint(alpha: CGFloat) -> UIColor {
    let colors = NativeChromeView.colors(for: selectedTheme)
    return colors.knobFill.withAlphaComponent(alpha)
  }

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
    let held = knobTint(alpha: NativeChromeView.knobHeldAlpha)
    UIViewPropertyAnimator(duration: 0.2, dampingRatio: 0.75) {
      self.knobWidth?.constant = NativeChromeView.knobHeldSize
      self.knobHeight?.constant = NativeChromeView.knobHeldSize
      self.knobLeading?.constant = target
      /* The disc thins to a drop in the same breath as it swells, which is
         the whole of the press — see knobRestingAlpha. On 26 only: the
         fallback blur below it carries no tint of its own, so swapping the
         effect down there would buy a crossfade and nothing else. Note what
         is absent from this animator as much as what is in it — the track's
         size, fill, outline and effect are all untouched, on press as on
         release, because only the knob is allowed to move. */
      if #available(iOS 26.0, *) {
        self.knob.effect = NativeChromeView.knobEffect(tint: held)
      }
      self.layoutIfNeeded()
    }.startAnimation()
  }

  /// The reverse of growKnob(), back to whatever stop is selected at the
  /// moment it runs — called after setTheme(_:) on a committing drag, so by
  /// then selectedTheme already names the stop this should settle onto.
  private func shrinkKnob() {
    let target = restingKnobLeading
    let resting = knobTint(alpha: NativeChromeView.knobRestingAlpha)
    UIViewPropertyAnimator(duration: 0.2, dampingRatio: 0.75) {
      self.knobWidth?.constant = NativeChromeView.knobRestingSize
      self.knobHeight?.constant = NativeChromeView.knobRestingSize
      self.knobLeading?.constant = target
      if #available(iOS 26.0, *) {
        self.knob.effect = NativeChromeView.knobEffect(tint: resting)
      }
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
        selectTheme(NativeChromeView.themes[index])
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
    selectTheme(NativeChromeView.themes[sender.tag])
  }

  /// Every route a theme can be chosen by ends here — a segment's action, a
  /// stop button's tap, a drag that commits — so the control on screen and
  /// the web app are told in the same order by all three.
  private func selectTheme(_ theme: String) {
    setTheme(theme)
    onTheme?(theme)
  }
}
