#!/usr/bin/env bun
// Client-only build for local screenshot preview.
// Produces dist-preview/{app.js,styles.css,index.html} + copies public/.

import path from "path";
import fs from "fs/promises";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "dist-preview");
const CLIENT = path.join(ROOT, "src/client");

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

// 1) JS
console.log("Building app.tsx...");
const js = await Bun.build({
    entrypoints: [path.join(CLIENT, "app.tsx")],
    outdir: OUT,
    minify: false,
    sourcemap: "none",
    target: "browser",
});
if (!js.success) { for (const l of js.logs) console.error(l); process.exit(1); }

// 2) CSS
console.log("Building styles/index.css...");
const css = await Bun.build({
    entrypoints: [path.join(CLIENT, "styles/index.css")],
    outdir: OUT,
    minify: false,
});
if (!css.success) { for (const l of css.logs) console.error(l); process.exit(1); }

// 3) Copy public/
console.log("Copying public/ ...");
async function copyRec(src: string, dst: string) {
    const st = await fs.stat(src);
    if (st.isDirectory()) {
        await fs.mkdir(dst, { recursive: true });
        for (const entry of await fs.readdir(src)) {
            await copyRec(path.join(src, entry), path.join(dst, entry));
        }
    } else {
        await fs.copyFile(src, dst);
    }
}
await copyRec(path.join(CLIENT, "public"), OUT);

// 4) Emit an index.html that loads the built JS/CSS and stubs the backend.
const htmlSrc = await fs.readFile(path.join(CLIENT, "index.html"), "utf-8");
let html = htmlSrc
    .replace('href="/styles/index.css"', 'href="/index.css"')
    .replace('src="/dist/app.js"', 'src="/app.js"');

// Inject a lightweight stub for backend calls + Tauri detection + fake auth so the client boots.
const stub = `
<script>
  // Preview-mode fetch stub: return safe empty payloads so we can render the
  // home / empty state (Superjoy hero) without a running server.
  (function() {
    const realFetch = window.fetch.bind(window);
    const empty = (body) => new Response(JSON.stringify(body ?? {}), {status: 200, headers:{'Content-Type':'application/json'}});
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.startsWith('/api/')) {
        if (url.includes('/auth/status')) return empty({
          authenticated: true,
          anonMode: false,
          user: { id: 'preview', name: 'Jaden Garza', email: 'jaden@garza.online', profilePictureUrl: null }
        });
        if (url.includes('/auth/platform-url')) return empty({ platformFrontendUrl: 'http://localhost' });
        if (url.includes('/auth/config')) return empty({});
        if (url.includes('/tasks')) return empty({ tasks: [] });
        if (url.includes('/conversations')) return empty({ conversations: [] });
        if (url.includes('/skills')) return empty({ skills: [] });
        if (url.includes('/automations')) return empty({ automations: [] });
        if (url.includes('/mcp')) return empty({ tools: [] });
        if (url.includes('/settings')) return empty({});
        if (url.includes('/billing')) return empty({ credits: 999 });
        return empty({});
      }
      return realFetch(input, init);
    };
    // Silence WebSocket — client will retry but we don't need chat streaming.
    window.WebSocket = class { constructor() { setTimeout(()=>this.onerror && this.onerror(new Event('error')), 10); } addEventListener(){} close(){} };
  })();
</script>
`;
html = html.replace('</head>', stub + '</head>');

await fs.writeFile(path.join(OUT, "index.html"), html);
console.log("Preview ready at", OUT);
