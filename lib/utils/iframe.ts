/**
 * In-memory localStorage/sessionStorage shim, injected as the FIRST thing in the
 * document so the page's own scripts see working storage.
 *
 * The interactive iframe is sandboxed `allow-scripts` WITHOUT `allow-same-origin`
 * (intentional — combining them negates the sandbox for LLM-authored HTML). In a
 * null-origin document, touching `window.localStorage` throws a SecurityError;
 * many generated pages read/write storage in their setup code, so that throw
 * crashes the script before anything renders → a blank/black widget. This shim
 * replaces both storages with an in-memory implementation when the real ones are
 * inaccessible, keeping the sandbox intact while letting storage-using pages run.
 */
const STORAGE_SHIM = `<script data-iframe-storage-shim>
(function () {
  function makeStore() {
    var data = Object.create(null);
    return {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = Object.create(null); },
      key: function (i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      get length() { return Object.keys(data).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try { var s = window[name]; if (s) { s.getItem('__probe__'); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      try { Object.defineProperty(window, name, { value: makeStore(), configurable: true }); } catch (e) {}
    }
  });
})();
</script>`;

/**
 * Runtime-error capture, injected as the VERY FIRST script so it observes errors
 * from the storage shim and every page script that follows. Generated interactive
 * pages frequently die on a runtime error (a `JSON.parse` of malformed config, a
 * reference to a CDN lib that failed to load, …) → the script aborts and the
 * widget renders blank. The sandboxed (null-origin) iframe can't be read by the
 * editor, but it CAN `postMessage` out: this forwards `window.onerror`, unhandled
 * rejections and `console.error` to the parent, which stores them per scene and
 * feeds them to the editor agent — so it can diagnose a blank page instead of
 * guessing. Only touches `window.*` so it stays sandbox-safe and unit-testable.
 *
 * The most important errors (a `JSON.parse` that aborts setup) fire SYNCHRONOUSLY
 * while srcDoc parses — potentially before the parent has subscribed its `message`
 * listener (which it installs from a passive effect after inserting the iframe).
 * To avoid losing exactly the errors this feature exists to surface, every post is
 * also buffered, and the shim re-emits the whole buffer when the parent sends a
 * `{ __maicErrorReplayRequest: true }` message once its listener is ready. The
 * parent dedups, so the live + replayed copies collapse to one.
 */
const ERROR_CAPTURE_SHIM = `<script data-iframe-error-shim>
(function () {
  var buffer = [];
  function emit(errorKind, message) {
    try {
      window.parent.postMessage(
        { __maicInteractive: true, kind: 'runtime-error', errorKind: errorKind, message: message },
        '*'
      );
    } catch (e) {}
  }
  function post(errorKind, message) {
    message = String(message).slice(0, 1200);
    if (buffer.length < 50) buffer.push([errorKind, message]);
    emit(errorKind, message);
  }
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && d.__maicErrorReplayRequest === true) {
      for (var i = 0; i < buffer.length; i++) emit(buffer[i][0], buffer[i][1]);
    }
  });
  window.addEventListener('error', function (e) {
    if (e && e.message) {
      post('error', e.message + (e.filename ? ' (' + e.filename + ':' + (e.lineno || 0) + ')' : ''));
    } else if (e && e.target && (e.target.src || e.target.href)) {
      post('resource', 'Failed to load resource: ' + (e.target.src || e.target.href));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    post('unhandledrejection', (r && (r.stack || r.message)) || r || 'unhandled promise rejection');
  });
  try {
    var c = window.console;
    if (c && c.error) {
      var _ce = c.error;
      c.error = function () {
        try { post('console.error', Array.prototype.map.call(arguments, function (a) { return (a && a.stack) || String(a); }).join(' ')); } catch (e) {}
        return _ce.apply(c, arguments);
      };
    }
  } catch (e) {}
})();
</script>`;

/**
 * No-op fallback for KaTeX's `renderMathInElement`, injected alongside the other
 * shims (i.e. before any page script runs).
 *
 * Generated widget HTML carries a KaTeX auto-render setup script that calls
 * `renderMathInElement(...)` directly inside its DOMContentLoaded handler and
 * only wires up its MutationObserver / setInterval AFTER that first call. When
 * the CDN copy of auto-render never arrives (see makeCdnDepsNonBlocking — the
 * scripts are now loaded asynchronously and may be slow or blocked), that first
 * call would throw a ReferenceError and abort the rest of the setup. This guard
 * guarantees the symbol exists (as a no-op) so the setup always completes; when
 * the real auto-render script loads it simply overwrites the fallback and math
 * renders normally (the already-installed observer / interval pick it up).
 */
const KATEX_GUARD_SHIM = `<script data-iframe-katex-guard>
window.renderMathInElement = window.renderMathInElement || function () {};
</script>`;

/**
 * Matches the render-blocking KaTeX CDN loader that the generation pipeline
 * (lib/generation/interactive-post-processor.ts) injects into every widget:
 * a stylesheet <link> plus two classic <script src> tags from cdn.jsdelivr.net,
 * adjacent inside <head>.
 */
const CDN_KATEX_LOADER_RE =
  /<link rel="stylesheet" href="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)">\s*<script src="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)"><\/script>\s*<script src="(https:\/\/cdn\.jsdelivr\.net\/[^"]+)"><\/script>/i;

/**
 * Rewrite the blocking KaTeX CDN loader into a fully non-blocking dynamic load.
 *
 * Classic `<script src>` tags in <head> halt HTML parsing until they finish, so
 * a slow/unreachable CDN (offline, restricted networks — jsdelivr is unreliable
 * in parts of the deployment region) leaves <body> unparsed and the widget blank
 * and unusable, even for widgets (e.g. thought-experiment games) that never
 * render math. The replacement appends the scripts dynamically with `async`
 * (chained via onload so auto-render loads only after KaTeX) and the stylesheet
 * dynamically too — nothing blocks parsing or delays DOMContentLoaded, so the
 * widget renders and becomes interactive immediately regardless of CDN status.
 *
 * Returns the input unchanged when the loader pattern is absent (simple widgets,
 * or HTML already rewritten — the replacement no longer matches the blocking
 * pattern, so the transform is idempotent).
 */
export function makeCdnDepsNonBlocking(html: string): string {
  const match = html.match(CDN_KATEX_LOADER_RE);
  if (!match) return html;
  const [full, cssUrl, katexJs, autoRenderJs] = match;
  const loader = `<script data-iframe-katex-async>
(function () {
  function addScript(src, onload) {
    var s = document.createElement('script');
    s.src = src;
    s.async = true;
    if (onload) s.onload = onload;
    document.head.appendChild(s);
  }
  addScript(${JSON.stringify(katexJs)}, function () { addScript(${JSON.stringify(autoRenderJs)}); });
  var l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = ${JSON.stringify(cssUrl)};
  document.head.appendChild(l);
})();
</script>`;
  // Function replacer inserts the loader literally (no `$` substitution risk).
  return html.replace(full, () => loader);
}

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Injects a runtime-error capture shim + a storage shim (so sandboxed pages that
 * use localStorage don't crash) + a KaTeX no-op guard, plus CSS that ensures
 * proper sizing and scrolling behavior when HTML content is rendered via srcDoc
 * in an iframe. The shims are placed first so they run before the page's own
 * scripts (error capture first, so it also observes the storage shim). The
 * blocking KaTeX CDN loader is additionally rewritten to a non-blocking dynamic
 * load so a slow/blocked CDN can never blank the widget.
 */
export function patchHtmlForIframe(html: string): string {
  const iframeCss = `<style data-iframe-patch>
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  /* Fix min-h-screen: in iframes 100vh is the iframe height, which is correct,
     but ensure body actually fills it */
  body { min-height: 100vh; }
</style>`;

  const injection =
    '\n' + ERROR_CAPTURE_SHIM + '\n' + STORAGE_SHIM + '\n' + KATEX_GUARD_SHIM + '\n' + iframeCss;

  // De-block the CDN KaTeX loader before injecting the shims.
  const deBlocked = makeCdnDepsNonBlocking(html);

  // Insert right after <head> or at the start of the document
  const headIdx = deBlocked.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6; // after <head>
    return deBlocked.substring(0, insertPos) + injection + deBlocked.substring(insertPos);
  }

  const headWithAttrs = deBlocked.indexOf('<head ');
  if (headWithAttrs !== -1) {
    const closeAngle = deBlocked.indexOf('>', headWithAttrs);
    if (closeAngle !== -1) {
      const insertPos = closeAngle + 1;
      return deBlocked.substring(0, insertPos) + injection + deBlocked.substring(insertPos);
    }
  }

  // Fallback: prepend
  return injection + deBlocked;
}
