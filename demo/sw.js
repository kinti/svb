// SVB Service Worker polyfill: makes <img src="*.svb"> work in every browser.
// Intercepts .svb requests, decodes to SVG, responds as image/svg+xml.

// ?v= busts HTTP-cached module graphs: a visitor with an old cached
// decoder.js would otherwise keep running stale decode logic forever,
// because sw.js itself rarely changes (no update event, imports from cache).
import { decodeAsync } from '../src/browser-decode.js?v=3';

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.toLowerCase().endsWith('.svb')) return;
  if (url.searchParams.has('raw')) return; // escape hatch: fetch the raw binary
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      const buffer = await res.arrayBuffer();
      const { svg } = await decodeAsync(buffer);
      return new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': res.headers.get('Cache-Control') || 'no-cache',
          'X-SVB-Decoded': '1',
        },
      });
    } catch (err) {
      return new Response(`SVB decode failed: ${err.message}`, {
        status: 500,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
  })());
});
