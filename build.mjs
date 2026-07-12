#!/usr/bin/env node
/* ============================================================================
   WEATHERPASS JAPAN — public build
   ----------------------------------------------------------------------------
   Turns the human-readable dev original (rainpass.html) into a shipping file
   (weatherpassjapan.min.html) that is:
     • minified   — HTML+CSS+JS collapsed, comments stripped, whitespace gone
     • lightly obfuscated — dev comments & console noise removed, JS mangled by
                    terser (short local names) but NOT so aggressive that a
                    future edit becomes impossible
     • watermarked — a unique, invisible build id is embedded so a copied file
                    can be proven yours
     • sourcemap-free — nothing that reconstructs the original is emitted

   HONEST NOTE: a browser must receive HTML/CSS/JS in the clear to render it,
   so no front-end build can make code truly unreadable. This raises the effort
   to copy and gives you a provable fingerprint — the real protection is the
   PRIVATE repo + LICENSE (see PUBLISH.md).

   RUN
     node build.mjs --in ../rainpass.html --out ../dist/weatherpassjapan.min.html
   ============================================================================ */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { minify } from "html-minifier-terser";

function arg(name, def=null){const i=process.argv.indexOf("--"+name);return i>0?process.argv[i+1]:def;}

const IN  = path.resolve(arg("in",  "../rainpass.html"));
const OUT = path.resolve(arg("out", "../dist/weatherpassjapan.min.html"));

/* ---- 1. read source -------------------------------------------------------- */
let src = fs.readFileSync(IN, "utf8");
const rawBytes = Buffer.byteLength(src);

/* ---- 2. build fingerprint (watermark) -------------------------------------- */
/* deterministic-ish per build: content hash + timestamp, short + unique */
const stamp = new Date().toISOString();
const fp = crypto.createHash("sha256").update(src + stamp).digest("hex").slice(0, 16);
const buildId = "wpj-" + fp;

/* Watermark is injected THREE ways so removing one still leaves proof:
   (a) an HTML comment that survives at the very top (some copiers keep it),
   (b) a meta tag (structured, easy for you to grep on a suspect site),
   (c) an inert JS constant referenced nowhere (survives minify, invisible). */
const metaMark =
  `<meta name="x-build" content="${buildId}">` +
  `<meta name="x-origin" content="weatherpassjapan.com">`;
src = src.replace(/<head(\s[^>]*)?>/i, m => `${m}\n${metaMark}`);

/* inert JS constant — placed just before </body>; terser keeps it because it
   can't prove it's unused across the whole document */
const jsMark =
  `<script>/*!wpj*/window.__wpj=Object.freeze({b:"${buildId}",o:"weatherpassjapan.com",t:"${stamp}"});</script>`;
src = src.replace(/<\/body>/i, `${jsMark}\n</body>`);

/* ---- 3. strip dev-only noise BEFORE minify --------------------------------- */
/* remove console.* debug calls (keep console.error for real failures) */
src = src.replace(/console\.(log|debug|info|table|trace)\s*\([^;]*\);?/g, "");

/* ---- 4. minify (HTML + inline CSS + inline JS) ------------------------------ */
const out = await minify(src, {
  collapseWhitespace: true,
  conservativeCollapse: false,
  removeComments: true,               // kills dev comments (keeps none — see keeper below)
  ignoreCustomComments: [/^!wpj/, /^!/],  // keep our /*!wpj*/ marker & any /*! ... */
  minifyCSS: true,
  minifyJS: {
    compress: {
      drop_console: false,            // we already handled console selectively
      dead_code: true,
      passes: 2,
    },
    mangle: {
      // mangle local variable names (short, unreadable) but keep top-level
      // globals the app relies on across <script> layers intact.
      toplevel: false,
      reserved: [
        "state","ACTIVITIES","PLACES","I18N","P","CONFIG","IMG",
        "render","renderShelves","renderTrip","renderItin","filtered",
        "applyStatic","applyWeather","refreshWeather","fetchLiveWeather",
        "useGPS","setTab","showToast","openDetail","tripAdd","tripRemove",
        "scheduleDay","findSpot","originLabel","rpFarCheck","rpReachInfo",
        "WEATHERPASS_CONFIG","RAINPASS_CONFIG","__wpj"
      ],
    },
    format: { comments: /^!/ },       // keep bang-comments (our watermark)
  },
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  useShortDoctype: true,
  sortAttributes: true,
  sortClassName: true,
  // NO sourcemap — we never emit anything that reverses the mangle
});

/* prepend a visible legal banner comment (survives because HTML comment at
   position 0 is outside the minifier's element tree once we concat) */
const banner =
`<!-- WEATHERPASS JAPAN — © ${new Date().getFullYear()} All rights reserved.
     Unauthorized copying, redistribution, or reuse of this code is prohibited.
     Build ${buildId} · weatherpassjapan.com -->\n`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, banner + out);

/* ---- 5. report ------------------------------------------------------------- */
const outBytes = Buffer.byteLength(banner + out);
const pct = (100 * (1 - outBytes / rawBytes)).toFixed(1);
console.error("✓ built:", path.relative(process.cwd(), OUT));
console.error(`  size:  ${(rawBytes/1024).toFixed(0)}KB → ${(outBytes/1024).toFixed(0)}KB  (−${pct}%)`);
console.error(`  build id (watermark): ${buildId}`);
console.error(`  → grep a suspect site for "${buildId}" or meta[name=x-build] to prove origin`);

/* write the build id to a log you keep privately, so you have a record */
const logLine = `${stamp}\t${buildId}\t${path.basename(OUT)}\n`;
fs.appendFileSync(path.resolve(path.dirname(OUT), "..", "build-ids.log"), logLine);
