const { SITE_ORIGIN, SHELL_MARKER } = require("../../config.js");

/*
  The one page. It holds a `<web-view>` and nothing else.

  The marker in the URL is what tells the site it is inside the shell, and it
  is here rather than left to sniffing because it is true from the first
  frame. WeChat's own `__wxjs_environment` is set by a bridge script that can
  land after the first paint, and the user agent does not carry "miniProgram"
  on every client — so a page that waited for either could draw one frame of
  the wrong thing. See isMiniProgramShell in lib/platform.ts, which accepts
  all three.
*/
Page({
  data: {
    url: "",
  },

  onLoad(query) {
    /*
      A scene value or a share can carry a path — opening BandUp on the
      writing page rather than the home page. Anything else in the query is
      ignored: this is a URL the shell is about to open, so it decides what
      goes in it.

      encodeURIComponent, and then a check that what came back starts with a
      single slash: a path arriving from a share link is not trusted to be a
      path at all, and "//evil.example" is a protocol-relative URL that would
      send the web-view somewhere else entirely.
    */
    const requested = typeof query.path === "string" ? query.path : "/";
    const path = /^\/(?!\/)[\w\-/]*$/.test(requested) ? requested : "/";
    const separator = path.includes("?") ? "&" : "?";
    this.setData({ url: `${SITE_ORIGIN}${path}${separator}shell=${SHELL_MARKER}` });
  },

  /* A `<web-view>` that fails to load is a blank screen with no explanation,
     which is the worst of the failure modes available. */
  onError(event) {
    console.error("BandUp web-view failed to load", event && event.detail);
    wx.showToast({
      title: "Could not reach BandUp",
      icon: "none",
      duration: 3000,
    });
  },
});
