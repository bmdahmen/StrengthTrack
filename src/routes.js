// Embedded frontend assets (filled in by build.py)
const APP_HTML = __APP_HTML__;
const APP_JS = __APP_JS__;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/app.js') {
      return new Response(APP_JS, {
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
      });
    }

    if (url.pathname === '/') {
      return new Response(APP_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    return new Response('Not found', { status: 404 });
  },
};
