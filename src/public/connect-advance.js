// Browser-only auto-advance for the /connect interstitial.
//
// A real browser runs this and navigates to the sign-in anchor immediately, so
// the interstitial feels like an instant redirect. Link-preview crawlers
// (iMessage, Slack, etc.) fetch and parse HTML but do NOT execute JavaScript, so
// they never run this — the single-use sign-in token survives until a human's
// browser advances. The plain <a id="continue"> remains as a no-JS fallback.
//
// location.replace (not assign) so the interstitial is not left in history —
// the browser Back button skips it.
(function () {
  var link = document.getElementById('continue');
  if (link && link.href) {
    window.location.replace(link.href);
  }
})();
