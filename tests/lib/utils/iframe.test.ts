import { describe, expect, it } from 'vitest';
import { patchHtmlForIframe, makeCdnDepsNonBlocking } from '@/lib/utils/iframe';

/**
 * The render-blocking KaTeX CDN loader exactly as the generation pipeline
 * (lib/generation/interactive-post-processor.ts) injects it into every widget:
 * a stylesheet <link> + two classic <script src> tags inside <head>, followed by
 * the auto-render setup script that calls renderMathInElement on DOMContentLoaded.
 */
const KATEX_LOADER_HTML = `<!DOCTYPE html><html><head>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<script>
document.addEventListener("DOMContentLoaded", function() { renderMathInElement(document.body, {}); });
</script>
</head><body><div id="app">game</div></body></html>`;

describe('patchHtmlForIframe', () => {
  it('injects the storage shim and sizing CSS after <head>', () => {
    const out = patchHtmlForIframe(
      '<!DOCTYPE html><html><head><title>t</title></head><body></body></html>',
    );
    expect(out).toContain('data-iframe-storage-shim');
    expect(out).toContain('data-iframe-patch');
  });

  it('runs the storage shim before the page scripts', () => {
    const html =
      '<!DOCTYPE html><html><head><script>window.__x = localStorage.getItem("k");</script></head><body></body></html>';
    const out = patchHtmlForIframe(html);
    // The shim must appear before the page's own <script> so storage is safe by then.
    expect(out.indexOf('data-iframe-storage-shim')).toBeLessThan(out.indexOf('window.__x'));
  });

  it('the shim provides a working in-memory storage when the real one throws', () => {
    // Execute the injected shim against a fake window whose localStorage getter
    // throws (mirroring a null-origin sandboxed iframe), then assert the shim
    // installed a usable in-memory store.
    const out = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = out.match(/<script data-iframe-storage-shim>([\s\S]*?)<\/script>/)?.[1];
    expect(shim).toBeTruthy();

    const win: Record<string, unknown> = {};
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('sandboxed');
      },
    });
    Object.defineProperty(win, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('sandboxed');
      },
    });
    new Function('window', shim as string)(win);

    const ls = win.localStorage as Storage;
    expect(ls.getItem('missing')).toBeNull();
    ls.setItem('a', '1');
    expect(ls.getItem('a')).toBe('1');
    expect(ls.length).toBe(1);
    ls.removeItem('a');
    expect(ls.getItem('a')).toBeNull();
  });

  it('falls back to prepending when there is no <head>', () => {
    const out = patchHtmlForIframe('<div>no head</div>');
    // The error-capture shim is injected first, so it leads the prepended block.
    expect(out.startsWith('\n<script data-iframe-error-shim>')).toBe(true);
  });

  it('injects the error-capture shim before the storage shim and page scripts', () => {
    const html = '<!DOCTYPE html><html><head><script>boom()</script></head><body></body></html>';
    const out = patchHtmlForIframe(html);
    expect(out).toContain('data-iframe-error-shim');
    // error shim runs first → before storage shim → before page scripts, so it
    // catches errors from everything that follows.
    expect(out.indexOf('data-iframe-error-shim')).toBeLessThan(
      out.indexOf('data-iframe-storage-shim'),
    );
    expect(out.indexOf('data-iframe-storage-shim')).toBeLessThan(out.indexOf('boom()'));
  });

  it('the error shim posts runtime errors (onerror / resource / rejection / console.error) to the parent', () => {
    const out = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = out.match(/<script data-iframe-error-shim>([\s\S]*?)<\/script>/)?.[1];
    expect(shim).toBeTruthy();

    const posts: Array<[Record<string, unknown>, string]> = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const win = {
      parent: { postMessage: (m: Record<string, unknown>, o: string) => posts.push([m, o]) },
      addEventListener: (t: string, cb: (e: unknown) => void) => {
        handlers[t] = cb;
      },
      console: { error: (..._args: unknown[]) => {} },
    };
    new Function('window', shim as string)(win);

    handlers.error({ message: 'JSON.parse boom', filename: 'p.html', lineno: 12 });
    expect(posts[0][0]).toMatchObject({ kind: 'runtime-error', errorKind: 'error' });
    expect(posts[0][0].message).toContain('JSON.parse boom');
    expect(posts[0][1]).toBe('*');

    handlers.error({ target: { src: 'https://cdn/katex.js' } });
    expect(String(posts[1][0].message)).toContain('Failed to load resource');

    handlers.unhandledrejection({ reason: { message: 'rej' } });
    expect(posts[2][0]).toMatchObject({ errorKind: 'unhandledrejection' });

    win.console.error('console boom');
    expect(posts[3][0]).toMatchObject({ errorKind: 'console.error' });
    expect(String(posts[3][0].message)).toContain('console boom');
  });

  it('the error shim buffers errors and re-emits them on a parent replay request', () => {
    // Guards the subscribe-after-insert race: a page that throws synchronously
    // while srcDoc parses may post before the parent subscribes. The shim must
    // re-emit the whole buffer when the parent asks, so nothing is lost.
    const out = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = out.match(/<script data-iframe-error-shim>([\s\S]*?)<\/script>/)?.[1];
    const posts: Array<[Record<string, unknown>, string]> = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const win = {
      parent: { postMessage: (m: Record<string, unknown>, o: string) => posts.push([m, o]) },
      addEventListener: (t: string, cb: (e: unknown) => void) => {
        handlers[t] = cb;
      },
      console: { error: (..._args: unknown[]) => {} },
    };
    new Function('window', shim as string)(win);

    // Two errors fire "before the parent subscribed".
    handlers.error({ message: 'first boom' });
    handlers.unhandledrejection({ reason: { message: 'second boom' } });
    expect(posts).toHaveLength(2);

    // Parent now subscribes and requests a replay.
    handlers.message({ data: { __maicErrorReplayRequest: true } });
    expect(posts).toHaveLength(4);
    expect(String(posts[2][0].message)).toContain('first boom');
    expect(String(posts[3][0].message)).toContain('second boom');
    expect(posts[2][0]).toMatchObject({ kind: 'runtime-error', errorKind: 'error' });

    // An unrelated message must NOT trigger a replay.
    handlers.message({ data: { foo: 1 } });
    expect(posts).toHaveLength(4);
  });

  it('rewrites the blocking KaTeX CDN loader into a non-blocking dynamic load', () => {
    const out = patchHtmlForIframe(KATEX_LOADER_HTML);
    // No render-blocking <script src>…</script> tag from the CDN remains.
    expect(out).not.toMatch(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/);
    // The dynamic loader and the no-op guard are present.
    expect(out).toContain('data-iframe-katex-async');
    expect(out).toContain('data-iframe-katex-guard');
    // The CDN URLs are preserved (now loaded dynamically).
    expect(out).toContain('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js');
    expect(out).toContain('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js');
    expect(out).toContain('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css');
  });

  it('injects the KaTeX guard before the auto-render setup script', () => {
    const out = patchHtmlForIframe(KATEX_LOADER_HTML);
    // The no-op guard must run before the setup's renderMathInElement call so the
    // setup never throws when the CDN copy is absent.
    expect(out.indexOf('data-iframe-katex-guard')).toBeLessThan(
      out.indexOf('renderMathInElement(document.body'),
    );
  });

  it('the async loader appends chained scripts and the stylesheet without blocking', () => {
    const out = patchHtmlForIframe(KATEX_LOADER_HTML);
    const loader = out.match(/<script data-iframe-katex-async>([\s\S]*?)<\/script>/)?.[1];
    expect(loader).toBeTruthy();

    interface FakeEl {
      src?: string;
      href?: string;
      rel?: string;
      async?: boolean;
      onload?: () => void;
    }
    const appended: FakeEl[] = [];
    const doc = {
      createElement: () => {
        const el: FakeEl = {};
        return el;
      },
      head: { appendChild: (el: FakeEl) => appended.push(el) },
    };
    new Function('document', loader as string)(doc);

    // Immediately appended: the katex script (async, chained onload) + the CSS link.
    expect(appended).toHaveLength(2);
    expect(appended[0].src).toContain('katex.min.js');
    expect(appended[0].async).toBe(true);
    expect(typeof appended[0].onload).toBe('function');
    expect(appended[1].rel).toBe('stylesheet');
    expect(appended[1].href).toContain('katex.min.css');

    // auto-render is only appended after katex finishes loading (order preserved).
    appended[0].onload!();
    expect(appended).toHaveLength(3);
    expect(appended[2].src).toContain('auto-render.min.js');
    expect(appended[2].async).toBe(true);
  });

  it('leaves HTML without the KaTeX loader unchanged by the de-blocking transform', () => {
    const plain = '<html><head></head><body></body></html>';
    expect(makeCdnDepsNonBlocking(plain)).toBe(plain);
  });

  it('the de-blocking transform is idempotent', () => {
    const once = makeCdnDepsNonBlocking(KATEX_LOADER_HTML);
    const twice = makeCdnDepsNonBlocking(once);
    expect(twice).toBe(once);
  });

  it('coexists with generation-time non-blocking output (no double rewrite)', async () => {
    // Newer classrooms generated after the injectKatex hardening already carry a
    // non-blocking loader; the render-time transform must leave them untouched.
    const { postProcessInteractiveHtml } = await import('@/lib/generation/interactive-post-processor');
    const generated = postProcessInteractiveHtml(
      '<html><head></head><body><div id="w">widget</div></body></html>',
    );
    // Generated output no longer contains a render-blocking CDN <script src> tag.
    expect(generated).not.toMatch(/<script src="https:\/\/cdn\.jsdelivr\.net[^"]*"><\/script>/);
    // And the render-time de-blocking transform is a no-op on it.
    expect(makeCdnDepsNonBlocking(generated)).toBe(generated);
  });
});
