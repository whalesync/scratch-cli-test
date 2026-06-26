// Dismiss a cookie / consent banner — reject-first (privacy), browser-agnostic.
//
// Why this exists: consent walls (OneTrust, Cookiebot, Usercentrics, Osano, Ketch, …)
// render an overlay that *intercepts clicks* on the rest of the page. If you don't
// dismiss it first, your "Sign up" / "Try free" click silently does nothing
// (this is what stalled the Capsule run). Run this RIGHT AFTER each navigate,
// before interacting with the page.
//
// Usage:
//   Chrome ext:  javascript_tool({action:'javascript_exec', text:'<contents of this file>'})
//   gstack:      $B js "$(cat .claude/skills/connector-build-prepare/lib/dismiss-cookie-banner.js)"
//
// Returns a short string describing what it clicked (or that it found nothing).
// It prefers "Reject all" / "Decline" over "Accept". If it returns
// "no cookie banner button found" but a banner is clearly visible (e.g. Ketch in a
// cross-origin iframe that JS can't reach), fall back to: screenshot -> read the
// button's pixel coordinates -> computer left_click at that coordinate.
(function dismissCookieBanner() {
  // Order matters: reject-style patterns are tried before accept-style.
  var REJECT = /(reject all|reject|decline|deny|refuse|necessary only|only necessary|essential( cookies)? only|use necessary|continue without|do not (accept|agree)|opt[- ]?out)/i;
  var ACCEPT = /(accept all|accept|i agree|^agree$|allow all|got it|^ok$|allow cookies|allow|continue|i understand)/i;
  // Stable selectors for the big consent frameworks (reject entries first).
  var KNOWN = [
    '#onetrust-reject-all-handler',
    '#CybotCookiebotDialogBodyButtonDecline',
    '.osano-cm-denyAll',
    '[data-testid="uc-deny-all-button"]',        // Usercentrics
    'button[mode="secondary"][data-role="reject"]',
    'button[aria-label*="reject" i]',
    'button[aria-label*="decline" i]',
    '#onetrust-accept-btn-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '.osano-cm-acceptAll',
    '[data-testid="uc-accept-all-button"]',
    'button[aria-label*="accept" i]',
  ];

  function visible(e) {
    try {
      var r = e.getBoundingClientRect();
      return r && r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden';
    } catch (x) { return false; }
  }

  // Collect clickable elements across the main DOM, open shadow roots, and
  // same-origin iframes (cross-origin iframes are unreachable -> pixel-click fallback).
  function collect(root, acc, depth) {
    if (depth > 6) return acc;
    try {
      root.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]')
        .forEach(function (e) { acc.push(e); });
    } catch (x) {}
    try {
      root.querySelectorAll('*').forEach(function (e) {
        if (e.shadowRoot) collect(e.shadowRoot, acc, depth + 1);
      });
    } catch (x) {}
    try {
      root.querySelectorAll('iframe').forEach(function (f) {
        try { if (f.contentDocument) collect(f.contentDocument, acc, depth + 1); } catch (x) {}
      });
    } catch (x) {}
    return acc;
  }

  // 1) Known framework selectors (reject ones first, by array order).
  for (var i = 0; i < KNOWN.length; i++) {
    var e;
    try { e = document.querySelector(KNOWN[i]); } catch (x) { e = null; }
    if (e && visible(e)) { e.click(); return 'clicked known: ' + KNOWN[i]; }
  }

  // 2) Text match across DOM + shadow + same-origin iframes; reject preferred.
  var els = collect(document, [], 0).filter(visible);
  var label = function (e) {
    return ((e.innerText || e.textContent || e.value ||
      (e.getAttribute && e.getAttribute('aria-label')) || '') + '').trim();
  };
  var hit = els.find(function (e) { return REJECT.test(label(e)); });
  if (!hit) hit = els.find(function (e) { return ACCEPT.test(label(e)); });
  if (hit) { hit.click(); return 'clicked text: "' + label(hit).slice(0, 40) + '"'; }

  return 'no cookie banner button found';
})();
