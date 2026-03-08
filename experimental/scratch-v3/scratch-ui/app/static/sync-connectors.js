/**
 * Sync Connectors — SVG patch-cord lines between mapped fields.
 *
 * Draws cubic Bézier curves from source fields to destination fields,
 * matching the client-vite visual style. Recalculates on scroll and resize.
 * Reattaches automatically after HTMX swaps via htmx:afterSettle.
 */
(function () {
  function draw(container) {
    var svg = container.querySelector('.sync-connectors');
    if (!svg) return;

    var srcCol = container.querySelector('[data-side="source"]');
    var destCol = container.querySelector('[data-side="dest"]');
    if (!srcCol || !destCol) { svg.innerHTML = ''; return; }

    var cRect = container.getBoundingClientRect();
    var srcBounds = srcCol.getBoundingClientRect();
    var destBounds = destCol.getBoundingClientRect();
    var parts = [];

    function isVisible(el, colBounds) {
      var r = el.getBoundingClientRect();
      return r.bottom > colBounds.top + 40 && r.top < colBounds.bottom;
    }

    function addLine(srcPath, destPath, color, width, opacity) {
      var srcEl = srcCol.querySelector('[data-field-path="' + CSS.escape(srcPath) + '"]');
      var destEl = destCol.querySelector('[data-field-path="' + CSS.escape(destPath) + '"]');
      if (!srcEl || !destEl) return;
      if (!isVisible(srcEl, srcBounds) || !isVisible(destEl, destBounds)) return;

      var sr = srcEl.getBoundingClientRect();
      var dr = destEl.getBoundingClientRect();
      var y1 = sr.top + sr.height / 2 - cRect.top;
      var y2 = dr.top + dr.height / 2 - cRect.top;
      var x1 = srcBounds.right - cRect.left;
      var x2 = destBounds.left - cRect.left;
      var mid = (x1 + x2) / 2;

      parts.push(
        '<path d="M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + x2 + ',' + y2 + '"'
        + ' stroke="' + color + '" stroke-width="' + width + '" fill="none" opacity="' + opacity + '" stroke-linecap="round"/>'
        + '<circle cx="' + x1 + '" cy="' + y1 + '" r="' + width + '" fill="' + color + '" opacity="' + opacity + '"/>'
        + '<circle cx="' + x2 + '" cy="' + y2 + '" r="' + width + '" fill="' + color + '" opacity="' + opacity + '"/>'
      );
    }

    // Match key line (amber)
    var matchSrc = container.getAttribute('data-match-source');
    var matchDest = container.getAttribute('data-match-dest');
    if (matchSrc && matchDest) {
      addLine(matchSrc, matchDest, '#f59e0b', 2, 0.7);
    }

    // Mapping lines (green)
    var mappingsAttr = container.getAttribute('data-mappings');
    if (mappingsAttr) {
      try {
        var mappings = JSON.parse(mappingsAttr);
        for (var i = 0; i < mappings.length; i++) {
          var m = mappings[i];
          if (matchSrc && m[0] === matchSrc && m[1] === matchDest) continue;
          addLine(m[0], m[1], '#22c55e', 1.5, 0.5);
        }
      } catch (e) { /* ignore parse errors */ }
    }

    svg.innerHTML = parts.join('');
  }

  function attach() {
    var container = document.querySelector('sync-columns');
    if (!container) return;

    // Ensure SVG element exists
    if (!container.querySelector('.sync-connectors')) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'sync-connectors');
      container.appendChild(svg);
    }

    var calc = function () { draw(container); };

    // Initial draw after layout settles
    requestAnimationFrame(calc);

    var srcCol = container.querySelector('[data-side="source"]');
    var destCol = container.querySelector('[data-side="dest"]');
    if (srcCol) srcCol.addEventListener('scroll', calc, { passive: true });
    if (destCol) destCol.addEventListener('scroll', calc, { passive: true });
    window.addEventListener('resize', calc);

    // Store cleanup for next swap
    container._connCleanup = function () {
      if (srcCol) srcCol.removeEventListener('scroll', calc);
      if (destCol) destCol.removeEventListener('scroll', calc);
      window.removeEventListener('resize', calc);
    };
  }

  // Reattach after HTMX swaps (mapper re-renders on every action)
  document.body.addEventListener('htmx:afterSettle', function () {
    var prev = document.querySelector('sync-columns');
    if (prev && prev._connCleanup) prev._connCleanup();
    attach();
  });

  // Initial attach
  attach();
})();
