/*
  Compatibility alias for old bookmarks and shared links.

  A server redirect would break the static iOS export. The About page declares
  /about as its canonical URL, so both routes can render the same content
  without presenting /credits as the preferred address.
*/
export { default, metadata } from "../about/page";
