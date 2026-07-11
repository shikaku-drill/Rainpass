#!/usr/bin/env node
/* ============================================================================
   WEATHERPASS JAPAN — 3-provider catalog ingestion pipeline
   ----------------------------------------------------------------------------
   Turns Klook / KKday / Viator affiliate feeds into the exact `A(...)` rows
   WEATHERPASS uses, de-duplicating across providers and against the 64
   activities already hand-built into the app.

   WHY THIS SHAPE
   - Each provider ships a DIFFERENT format (Viator = JSON API, Klook = CSV,
     KKday = CSV/JSON once approved). We normalise all three to ONE internal
     record, then merge by geo+name so the same attraction sold on 2–3 sites
     becomes ONE card with k/d/v prices — exactly how the app compares them.
   - Nothing here invents products. If a provider doesn't list something, it
     simply isn't in that provider's price map. That keeps every booking link
     real and every "lowest price" honest.

   RUN
     node ingest.mjs --viator ./feeds/viator.json \
                     --klook  ./feeds/klook.csv \
                     --kkday  ./feeds/kkday.csv \
                     --out    ./out/activities.generated.js
   Any subset of providers is fine. With no feeds it runs the built-in mock
   so you can validate the whole path before affiliate approval lands.
   ============================================================================ */

import fs from "node:fs";
import path from "node:path";

/* ---- 1. PREFECTURE GEO-FENCES ------------------------------------------------
   We assign each product to one of the app's 15 implemented prefectures by
   nearest centroid, but only if it falls inside Japan and within a sane radius.
   Products outside these fences are dropped (we only list where we have areas). */
const PREF_CENTROIDS = {
  hokkaido:{lat:43.06,lng:141.35}, tokyo:{lat:35.68,lng:139.76},
  chiba:{lat:35.61,lng:140.12},    kanagawa:{lat:35.44,lng:139.64},
  aichi:{lat:35.18,lng:136.91},    ishikawa:{lat:36.56,lng:136.66},
  kyoto:{lat:35.01,lng:135.77},    osaka:{lat:34.69,lng:135.50},
  nara:{lat:34.69,lng:135.83},     hiroshima:{lat:34.40,lng:132.46},
  fukuoka:{lat:33.59,lng:130.40},  okinawa:{lat:26.21,lng:127.68},
};
const JP_BOUNDS = {latMin:24, latMax:45.8, lngMin:122.7, lngMax:149};
const PREF_MAX_KM = 90;   // a product further than this from every centroid is skipped

const R=6371;
const hav=(a,b)=>{const dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180,
  s=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));};
function nearestPref(lat,lng){
  if(lat<JP_BOUNDS.latMin||lat>JP_BOUNDS.latMax||lng<JP_BOUNDS.lngMin||lng>JP_BOUNDS.lngMax)return null;
  let best=null,bd=1e9;
  for(const[p,c]of Object.entries(PREF_CENTROIDS)){const d=hav({lat,lng},c);if(d<bd){bd=d;best=p;}}
  return bd<=PREF_MAX_KM?best:null;
}

/* ---- 2. CATEGORY + WEATHER CLASSIFICATION -----------------------------------
   The app needs a `cat` (one of its 9 chips) and `wx` ("in"|"out").
   We map from provider tags/titles. Indoor vs outdoor drives the whole
   rain-or-shine engine, so we err toward "in" only on strong indoor signals. */
const CAT_RULES = [
  [/aquarium|水族館|水族|penguin/i,               "aqua",    "in"],
  [/museum|美術館|博物館|gallery|teamlab|art|планет/i,"art",   "in"],
  [/theme ?park|ディズニー|usj|universal|disney|遊園/i,"theme", "in"],
  [/onsen|温泉|spa|스파|溫泉|hot spring|sauna/i,     "relax",   "in"],
  [/cooking|sushi|ramen|寿司|料理|food|グルメ|tasting|美食|kitchen/i,"food","in"],
  [/kimono|着物|tea ceremony|茶道|calligraphy|craft|工芸|体験|workshop|pottery/i,"culture","in"],
  [/observation|展望|sky ?deck|tower|타워|夜景|観覧車|ferris/i,"views","in"],
  [/tour|ツアー|guided|day ?trip|cruise|クルーズ|walking|sightseeing|巡り/i,"tours","out"],
  [/garden|庭園|park|公園|shrine|神社|temple|寺|castle|城|hike|登山|beach|ビーチ|snorkel|dive|kayak|raft|cycl|surf/i,"play","out"],
];
function classify(title, tags=[]){
  const hay=(title+" "+tags.join(" "));
  for(const[re,cat,wx]of CAT_RULES)if(re.test(hay))return{cat,wx};
  return{cat:"tours",wx:"out"};   // safe default: treated as weather-sensitive
}

/* ---- 3. GLYPH + GRADIENT (visual fallback when no photo) --------------------- */
const GLYPH={aqua:"🐟",art:"🎨",theme:"🎡",relax:"♨️",food:"🍣",culture:"🏮",views:"🌆",tours:"🚌",play:"⛩️"};
const GRAD={
  aqua:"linear-gradient(135deg,#0E4E7E,#1D8FBF 60%,#7CC3FF)",
  art:"linear-gradient(135deg,#3B0F4E,#8F2FA8 60%,#FFB4E0)",
  theme:"linear-gradient(135deg,#7A2E1D,#D9631D 60%,#FFC24D)",
  relax:"linear-gradient(135deg,#7A3B0F,#C77F1D 60%,#F0C89B)",
  food:"linear-gradient(135deg,#7A1D2E,#C7304D 60%,#FF9BB0)",
  culture:"linear-gradient(135deg,#4E2E0F,#8F5E1D 60%,#E0C29B)",
  views:"linear-gradient(135deg,#0F2440,#2F5E9E 60%,#9BC3FF)",
  tours:"linear-gradient(135deg,#1D3D5E,#3D7FBF 60%,#9BD0FF)",
  play:"linear-gradient(135deg,#0F3D2B,#1D8F5E 60%,#7CFFC3)",
};

/* ---- 4. PROVIDER PARSERS -> internal record ---------------------------------
   Internal record: {src, code, title, lat, lng, price(JPY), rating, reviews,
                     durMin, url, image, tags[]}
   Currency: feeds may quote USD/local; we convert to JPY with a fixed table
   for display parity (the app always books in the site's real yen price). */
const FX_TO_JPY={JPY:1, USD:155, TWD:4.8, HKD:19.8, EUR:168, KRW:0.107, SGD:115};
const toJPY=(amt,cur)=>Math.round((amt||0)*(FX_TO_JPY[(cur||"JPY").toUpperCase()]??1));

// VIATOR — Partner API /products/search response objects
function parseViator(json){
  const arr = Array.isArray(json)?json : (json.products||json.data||[]);
  return arr.map(p=>{
    const c=p.pricing?.summary?.fromPrice ?? p.fromPrice ?? p.price?.amount;
    const cur=p.pricing?.currency ?? p.currency ?? "USD";
    const geo=p.location||p.geoLocation||{};
    return {
      src:"v", code:String(p.productCode||p.code||p.productId),
      title:(p.title||p.name||"").trim(),
      lat:+(geo.latitude ?? geo.lat), lng:+(geo.longitude ?? geo.lng),
      price:toJPY(c,cur),
      rating:+(p.reviews?.combinedAverageRating ?? p.rating ?? 0)||null,
      reviews:+(p.reviews?.totalReviews ?? p.reviewCount ?? 0)||0,
      durMin:minutesFrom(p.duration),
      url:p.productUrl||p.webURL||p.url||"",
      image:(p.images?.[0]?.variants?.slice(-1)[0]?.url)||p.thumbnailURL||p.image||"",
      tags:(p.tags||p.categories||[]).map(String),
    };
  });
}
// KLOOK — CSV feed (AWIN/affiliate-toolkit style). Header-mapped, tolerant.
function parseKlook(rows){
  return rows.map(r=>({
    src:"k", code:String(r.activity_id||r.id||r.product_id||r.sku||""),
    title:(r.activity_name||r.name||r.title||"").trim(),
    lat:+(r.latitude||r.lat), lng:+(r.longitude||r.lng),
    price:toJPY(+(r.price||r.from_price||r.selling_price||0), r.currency||"USD"),
    rating:+(r.rating||r.review_score||0)||null,
    reviews:+(r.review_count||r.reviews||0)||0,
    durMin:minutesFrom(r.duration||r.duration_minutes),
    url:r.deeplink||r.aff_url||r.url||r.activity_url||"",
    image:r.image||r.image_url||r.cover_image||"",
    tags:String(r.category||r.tags||"").split(/[|,;]/).filter(Boolean),
  }));
}
// KKDAY — CSV/JSON once approved. Same tolerant shape as Klook.
function parseKKday(rows){
  return rows.map(r=>({
    src:"d", code:String(r.prod_no||r.product_id||r.id||""),
    title:(r.prod_name||r.name||r.title||"").trim(),
    lat:+(r.lat||r.latitude), lng:+(r.lng||r.longitude),
    price:toJPY(+(r.price||r.sale_price||0), r.currency||"TWD"),
    rating:+(r.rating||r.score||0)||null,
    reviews:+(r.comment_count||r.reviews||0)||0,
    durMin:minutesFrom(r.duration),
    url:r.url||r.deeplink||r.link||"",
    image:r.img||r.image||r.cover||"",
    tags:String(r.category||r.tags||"").split(/[|,;]/).filter(Boolean),
  }));
}
function minutesFrom(d){
  if(d==null)return 120;
  if(typeof d==="number")return d>600?Math.round(d/60):d;   // secs vs mins guard
  const m=String(d).match(/(\d+(\.\d+)?)\s*(h|hour|時間|小時|시간)/i);
  if(m)return Math.round(parseFloat(m[1])*60);
  const mm=String(d).match(/(\d+)\s*(m|min|分)/i);
  if(mm)return +mm[1];
  return 120;
}

/* ---- 5. CSV reader (no deps) ------------------------------------------------- */
function readCSV(file){
  const txt=fs.readFileSync(file,"utf8").replace(/^\uFEFF/,"");
  const lines=txt.split(/\r?\n/).filter(l=>l.length);
  if(!lines.length)return[];
  const split=l=>{const out=[];let cur="",q=false;
    for(let i=0;i<l.length;i++){const ch=l[i];
      if(q){if(ch==='"'){if(l[i+1]==='"'){cur+='"';i++;}else q=false;}else cur+=ch;}
      else{if(ch===','){out.push(cur);cur="";}else if(ch==='"')q=true;else cur+=ch;}}
    out.push(cur);return out;};
  const head=split(lines[0]).map(h=>h.trim().toLowerCase().replace(/\s+/g,"_"));
  return lines.slice(1).map(l=>{const c=split(l);const o={};head.forEach((h,i)=>o[h]=c[i]);return o;});
}

/* ---- 6. STABLE ID from title (kebab, ascii-ish) ------------------------------ */
function slugId(title, pref){
  const base=title.toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g,"-")
    .replace(/(^-|-$)/g,"").slice(0,40);
  const ascii=base.replace(/[^a-z0-9-]/g,"");
  return (ascii||("p-"+pref))+"-"+hash(title).toString(36).slice(0,4);
}
function hash(s){let h=0;for(let i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))|0;}return h>>>0;}

/* ---- 7. MERGE across providers + against existing app ids -------------------- */
function loadExistingIds(appFile){
  if(!appFile||!fs.existsSync(appFile))return{ids:new Set(),geos:[]};
  const src=fs.readFileSync(appFile,"utf8");
  const ids=new Set([...src.matchAll(/\bA\("([^"]+)"/g)].map(m=>m[1]));
  // rough geo of existing rows to catch cross-provider dupes of hand-built cards
  const geos=[...src.matchAll(/\bA\("([^"]+)","[a-z]+","[a-z]+","[a-z]+","[^"]*",([\d.]+),([\d.]+)/g)]
    .map(m=>({id:m[1],lat:+m[2],lng:+m[3]}));
  return{ids,geos};
}
function keyGeo(r){return Math.round(r.lat*200)/200+","+Math.round(r.lng*200)/200;} // ~500m bucket

const STOP=new Set(["the","a","and","of","tour","tours","ticket","tickets","day","trip","guided","experience","admission","pass","&","in","to","at","with","from","private","group","half","full","hours","hour"]);
function tokens(t){return new Set(t.toLowerCase().replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g," ")
  .split(/\s+/).filter(w=>w.length>1&&!STOP.has(w)));}
function tokenSim(a,b){          // Jaccard over meaningful tokens
  const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;
  let inter=0;for(const x of A)if(B.has(x))inter++;
  return inter/(A.size+B.size-inter);
}
function merge(records, existing){
  // group by proximity + name similarity so the same attraction across sites
  // (e.g. Viator "Nara Park & Todai-ji" vs KKday "Nara Todai-ji & Deer Park")
  // collapses into ONE card carrying k/d/v prices.
  const groups=[];
  for(const r of records){
    if(!r.title||!isFinite(r.lat)||!isFinite(r.lng)||!r.price)continue;
    const pref=nearestPref(r.lat,r.lng); if(!pref)continue;
    r.pref=pref;
    let g=groups.find(g=>hav(g,r)<1.2 && tokenSim(g.title,r.title)>=0.34);
    if(g){ g.pr[r.src]=r.price; g.srcs.add(r.src);
      if(r.url)g.urls[r.src]=r.url;
      if(!g.image&&r.image)g.image=r.image;
      if((r.reviews||0)>(g.reviews||0)){g.rating=r.rating;g.reviews=r.reviews;}
    } else {
      groups.push({...r, pr:{[r.src]:r.price}, urls:r.url?{[r.src]:r.url}:{}, srcs:new Set([r.src])});
    }
  }
  // drop groups whose geo collides with an already hand-built card
  return groups.filter(g=>{
    for(const e of existing.geos){if(hav(e,g)<0.4)return false;}
    return true;
  });
}

/* ---- 8. EMIT A(...) rows ----------------------------------------------------- */
function esc(s){return String(s).replace(/\\/g,"\\\\").replace(/"/g,'\\"');}
function emit(groups, existing){
  const seen=new Set(existing.ids); const out=[];
  for(const g of groups){
    let id=slugId(g.title,g.pref); while(seen.has(id))id+="x"; seen.add(id);
    const {cat,wx}=classify(g.title,g.tags);
    const best = g.pr.k!=null?"k": g.pr.d!=null?"d":"v";       // cheapest chosen at runtime anyway
    const pr = `{k:${g.pr.k??"null"},d:${g.pr.d??"null"},v:${g.pr.v??"null"}}`;
    const rating=(g.rating||4.3).toFixed(1);
    const rv=g.reviews||0;
    const dur=g.durMin||120;
    const nm=`{en:"${esc(g.title)}",ja:"${esc(g.title)}","zh-Hant":"${esc(g.title)}","zh-Hans":"${esc(g.title)}",ko:"${esc(g.title)}"}`;
    const area=`{en:"${g.pref}",ja:"${g.pref}","zh-Hant":"${g.pref}","zh-Hans":"${g.pref}",ko:"${g.pref}"}`;
    const desc=`{en:"",ja:"",\"zh-Hant\":"",\"zh-Hans\":"",ko:""}`;
    const img=g.image?`"${esc(g.image)}"`:"null";
    // close/last/bs/fc/avail are provider-agnostic sensible defaults; the app
    // treats them as soft signals and they can be enriched later per product.
    out.push(
`A("${id}","${g.pref}","${cat}","${wx}","${GLYPH[cat]}",${g.lat.toFixed(4)},${g.lng.toFixed(4)},${pr},${rating},${rv},"21:00","20:00",${dur},0,1,"today","${best}","${GRAD[cat]}",\n ${nm},\n ${area},\n ${desc},${img});`
    );
  }
  return out;
}

/* ---- 9. MOCK feed (pre-approval dry run) ------------------------------------- */
function mockFeeds(){
  return {
    viator: parseViator({products:[
      {productCode:"V-otaru-canal",title:"Otaru Canal Evening Walking Tour",location:{latitude:43.198,longitude:141.001},
       pricing:{summary:{fromPrice:22},currency:"USD"},reviews:{combinedAverageRating:4.6,totalReviews:1240},
       duration:"2 hours",productUrl:"https://www.viator.com/tours/Otaru/x/d0000-000",images:[{variants:[{url:"https://img/otaru.jpg"}]}],tags:["Walking tour"]},
      {productCode:"V-nara-deer",title:"Nara Park & Todai-ji Guided Day Trip",location:{latitude:34.685,longitude:135.843},
       pricing:{summary:{fromPrice:60},currency:"USD"},reviews:{combinedAverageRating:4.8,totalReviews:5400},
       duration:"6 hours",productUrl:"https://www.viator.com/tours/Nara/x/d0-1",tags:["Day trip"]},
    ]}),
    klook: parseKlook([
      {activity_id:"K-otaru-canal",activity_name:"Otaru Canal Cruise",latitude:43.197,longitude:141.002,
       price:"25",currency:"USD",rating:"4.5",review_count:"860",duration:"40 min",
       deeplink:"https://www.klook.com/activity/otaru-canal/",image:"https://img/otaruk.jpg",category:"Cruise"},
      {activity_id:"K-hako-onsen",activity_name:"Hakone Yuryo Onsen Ticket",latitude:35.233,longitude:139.052,
       price:"18",currency:"USD",rating:"4.4",review_count:"3200",duration:"3 h",
       deeplink:"https://www.klook.com/activity/hakone-yuryo/",category:"Onsen / Spa"},
    ]),
    kkday: parseKKday([
      {prod_no:"D-nara-deer",prod_name:"Nara Todai-ji & Deer Park Tour",lat:34.686,lng:135.840,
       price:"1800",currency:"TWD",rating:"4.7",comment_count:"2100",duration:"6h",
       url:"https://www.kkday.com/product/nara-deer",category:"Day Trip"},
    ]),
  };
}

/* ---- 10. CLI ----------------------------------------------------------------- */
function arg(name){const i=process.argv.indexOf("--"+name);return i>0?process.argv[i+1]:null;}
function main(){
  const appFile=arg("app")||path.resolve("../rainpass.html");
  const existing=loadExistingIds(appFile);
  let records=[];
  const vf=arg("viator"), kf=arg("klook"), df=arg("kkday");
  if(!vf&&!kf&&!df){
    console.error("• No feeds passed — running built-in MOCK (pre-approval dry run).");
    const m=mockFeeds(); records=[...m.viator,...m.klook,...m.kkday];
  }else{
    if(vf)records.push(...parseViator(JSON.parse(fs.readFileSync(vf,"utf8"))));
    if(kf)records.push(...parseKlook(readCSV(kf)));
    if(df)records.push(...(df.endsWith(".json")?parseKKday(JSON.parse(fs.readFileSync(df,"utf8"))):parseKKday(readCSV(df))));
  }
  const merged=merge(records, existing);
  const rows=emit(merged, existing);
  const outFile=arg("out")||"./out/activities.generated.js";
  fs.mkdirSync(path.dirname(outFile),{recursive:true});
  const header=`/* AUTO-GENERATED by catalog-pipeline/ingest.mjs — do not edit by hand.
   Source products: ${records.length} · merged cards: ${merged.length}
   Providers present: ${[...new Set(records.map(r=>r.src))].join(",")||"none"}
   Existing app ids skipped for de-dup: ${existing.ids.size}
   Generated: ${new Date().toISOString()} */\n`;
  fs.writeFileSync(outFile, header+rows.join("\n")+"\n");
  // provenance report
  const byPref={}; merged.forEach(g=>{byPref[g.pref]=(byPref[g.pref]||0)+1;});
  console.error(`✓ ${records.length} source products → ${merged.length} unique cards`);
  console.error("  per prefecture:", JSON.stringify(byPref));
  console.error("  written:", outFile);
}
main();
