import type { ThreadExport } from "./store.ts";

/** Human-readable locations: working dirs (repo git dirs minus /.git) first, then remotes. */
export function locations(links: { kind: string; value: string }[]): string[] {
  const dirs = links.filter((l) => l.kind === "dir" || l.value.startsWith("/")).map((l) => l.value.replace(/\/\.git\/?$/, ""));
  const remotes = links.filter((l) => !(l.kind === "dir" || l.value.startsWith("/"))).map((l) => l.value);
  return [...new Set([...dirs, ...remotes])];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Self-contained HTML page: collapsible tree + dependency graph (SVG), no external assets. */
export function exportHtml(x: ThreadExport, live?: { poll: string; version: string }): string {
  // `<` escaped so node text can never close the <script> element.
  const data = JSON.stringify(x).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(x.thread.title)} (${esc(x.thread.id)})</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1b;--mute:#6b6b66;--line:#dcdcd6;--card:#fff;--open:#6b6b66;--active:#2f6fdb;--blocked:#c2410c;--done:#15803d;--abandoned:#9a9a94;--hl:#fff4c2}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#e8e8e4;--mute:#9a9a94;--line:#34342f;--card:#1f1f1d;--open:#9a9a94;--active:#6ea0ff;--blocked:#fb923c;--done:#4ade80;--abandoned:#6b6b66;--hl:#3a3316}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px}
.meta,.mute{color:var(--mute)}.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:14px 0}
input,button{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
button.on{border-color:var(--fg)}ul{list-style:none;margin:0;padding-left:18px}#tree>ul{padding-left:0}
.n{padding:2px 0}.row{display:flex;gap:6px;align-items:baseline;cursor:pointer;border-radius:4px;padding:1px 4px}
.row:hover{background:var(--card)}.n.hl>.row{background:var(--hl)}.tw{width:12px;flex:none;color:var(--mute)}
.id{font:12px ui-monospace,monospace;color:var(--mute)}.dot{width:8px;height:8px;border-radius:50%;flex:none;align-self:center}
.tag{font-size:11px;border:1px solid var(--line);border-radius:10px;padding:0 6px;color:var(--mute)}
.det{margin:2px 0 6px 22px;padding:6px 10px;border-left:2px solid var(--line);white-space:pre-wrap;display:none}.n.open>.det{display:block}
.det b{font-weight:600}.gone>.row .t{color:var(--abandoned);text-decoration:line-through}.hide{display:none}
a{color:var(--active)}#graph{overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
svg text{fill:var(--fg);font:12px system-ui,sans-serif}svg .e{stroke:var(--mute);fill:none}svg g.g{cursor:pointer}
</style></head><body><main>
${live ? `<p class="meta"><a href="/">← all threads</a> · live</p>` : ""}<h1 id="title"></h1><div class="meta" id="meta"></div><div class="meta" id="loc"></div><p id="goal"></p>
<div class="bar"><input id="q" placeholder="Filter…" size="24"><span id="st"></span>
<button id="exp">Expand all</button><button id="col">Collapse all</button></div>
<div id="tree"></div>
<h2>Dependencies</h2><div id="graph"></div>
<h2>Checkpoints</h2><div id="cps"></div>
</main>
<script>
const X=${data};
const S=["open","active","blocked","done","abandoned"],C=s=>"var(--"+s+")";
const $=id=>document.getElementById(id),el=(t,a={},...k)=>{const e=document.createElement(t);for(const[q,v]of Object.entries(a))q==="style"?e.style.cssText=v:q.startsWith("on")?e.addEventListener(q.slice(2),v):e.setAttribute(q,v);e.append(...k);return e};
$("title").textContent=X.thread.title+" ("+X.thread.id+")";
$("meta").textContent=X.thread.status+" · created "+X.thread.created_at.slice(0,10)+" · touched "+X.thread.touched_at.slice(0,10)+" · exported "+X.exported_at.slice(0,16).replace("T"," ");
const LOC=${JSON.stringify(locations(x.links)).replace(/</g, "\\u003c")};if(LOC.length)$("loc").append(...LOC.flatMap((l,i)=>[i?" · ":"📁 ",el("code",{},l)]));
if(X.thread.goal)$("goal").append(el("b",{},"Goal: "),X.thread.goal);
const by=new Map(X.nodes.map(n=>[n.id,n])),kids=new Map(),blk=new Map(),blks=new Map(),li=new Map();
for(const n of X.nodes)kids.set(n.parent_id,[...(kids.get(n.parent_id)||[]),n]);
for(const e of X.edges)if(e.type==="blocks"){blk.set(e.to_id,[...(blk.get(e.to_id)||[]),e.from_id]);blks.set(e.from_id,[...(blks.get(e.from_id)||[]),e.to_id])}
const link=id=>el("a",{href:"#"+id,onclick:ev=>{ev.preventDefault();go(id)}},id);
const list=(lbl,ids)=>ids&&ids.length?[el("b",{},lbl+": "),...ids.flatMap((id,i)=>i?[", ",link(id)]:[link(id)]),"\\n"]:[];
function build(pid){const ch=kids.get(pid);if(!ch)return null;const ul=el("ul");for(const n of ch){
 const tags=[n.kind!=="task"?n.kind:"",n.priority?"p"+n.priority:"",n.confidence!=null?"conf "+n.confidence:""].filter(Boolean);
 const sub=build(n.id),tw=el("span",{class:"tw"},sub?"▾":"");
 const row=el("div",{class:"row"},tw,el("span",{class:"dot",style:"background:"+C(n.status),title:n.status}),el("span",{class:"id"},n.id),el("span",{class:"t"},n.title),...tags.map(t=>el("span",{class:"tag"},t)),...(blk.has(n.id)?[el("span",{class:"tag"},"blocked by "+blk.get(n.id).join(", "))]:[]));
 const det=el("div",{class:"det"},el("span",{class:"mute"},n.status+" · updated "+n.updated_at.slice(0,16).replace("T"," ")+"\\n"),
  ...(n.body?[el("b",{},"Body: "),n.body+"\\n"]:[]),...(n.summary?[el("b",{},"Summary: "),n.summary+"\\n"]:[]),
  ...(n.refs&&n.refs.length?[el("b",{},"Refs: "),n.refs.join(", ")+"\\n"]:[]),...list("Blocked by",blk.get(n.id)),...list("Blocks",blks.get(n.id)));
 const item=el("li",{class:"n"+(n.status==="abandoned"?" gone":""),id:"n-"+n.id},row,det);
 if(sub){item.append(sub);tw.onclick=ev=>{ev.stopPropagation();sub.classList.toggle("hide");tw.textContent=sub.classList.contains("hide")?"▸":"▾"}}
 row.onclick=()=>item.classList.toggle("open");li.set(n.id,item);ul.append(item)}return ul}
$("tree").append(build(null)||el("p",{class:"mute"},"No nodes."));
function go(id){const it=li.get(id);if(!it)return;for(let p=it.parentElement;p&&p.id!=="tree";p=p.parentElement)if(p.tagName==="UL")p.classList.remove("hide");
 for(const e of document.querySelectorAll(".hl"))e.classList.remove("hl");it.classList.add("hl","open");it.scrollIntoView({block:"center",behavior:"smooth"})}
// filters
const on=new Set(S);
for(const s of S){const c=X.nodes.filter(n=>n.status===s).length;if(!c)continue;const b=el("button",{class:"on"},el("span",{class:"dot",style:"display:inline-block;margin-right:5px;background:"+C(s)}),s+" "+c);
 b.onclick=()=>{on.has(s)?on.delete(s):on.add(s);b.classList.toggle("on");filt()};$("st").append(b," ")}
$("q").oninput=filt;
function filt(){const q=$("q").value.toLowerCase();const vis=n=>on.has(n.status)&&(!q||(n.id+" "+n.title+" "+(n.body||"")+" "+(n.summary||"")).toLowerCase().includes(q));
 const walk=pid=>{let any=false;for(const n of kids.get(pid)||[]){const k=walk(n.id),v=vis(n)||k;li.get(n.id).classList.toggle("hide",!v);any=any||v}return any};walk(null)}
$("exp").onclick=()=>{for(const u of document.querySelectorAll("#tree ul"))u.classList.remove("hide");for(const t of document.querySelectorAll(".tw"))if(t.textContent)t.textContent="▾"};
$("col").onclick=()=>{for(const u of document.querySelectorAll("#tree ul ul"))u.classList.add("hide");for(const t of document.querySelectorAll(".tw"))if(t.textContent)t.textContent="▸"};
// dependency graph: nodes touching a blocks edge, layered by longest path
(function(){const ids=[...new Set(X.edges.filter(e=>e.type==="blocks").flatMap(e=>[e.from_id,e.to_id]))].filter(id=>by.has(id));
 if(!ids.length){$("graph").replaceWith(el("p",{class:"mute"},"No dependency edges."));return}
 const L=new Map(),lv=(id,seen=new Set())=>{if(L.has(id))return L.get(id);if(seen.has(id))return 0;seen.add(id);const v=Math.max(-1,...(blk.get(id)||[]).filter(i=>by.has(i)).map(i=>lv(i,seen)))+1;L.set(id,v);return v};
 ids.forEach(id=>lv(id));const cols=[];for(const id of ids)(cols[L.get(id)]??=[]).push(id);
 const W=190,H=34,GX=60,GY=14,pos=new Map();cols.forEach((c,i)=>c.forEach((id,j)=>pos.set(id,{x:16+i*(W+GX),y:16+j*(H+GY)})));
 const w=32+cols.length*(W+GX)-GX,h=32+Math.max(...cols.map(c=>c.length))*(H+GY)-GY,NS="http://www.w3.org/2000/svg";
 const s=(t,a,...k)=>{const e=document.createElementNS(NS,t);for(const[q,v]of Object.entries(a))e.setAttribute(q,v);e.append(...k);return e};
 const svg=s("svg",{width:w,height:h,viewBox:"0 0 "+w+" "+h},s("defs",{},s("marker",{id:"ar",viewBox:"0 0 10 10",refX:9,refY:5,markerWidth:7,markerHeight:7,orient:"auto"},s("path",{d:"M0,0L10,5L0,10z",fill:"var(--mute)"}))));
 for(const e of X.edges){const a=pos.get(e.from_id),b=pos.get(e.to_id);if(e.type!=="blocks"||!a||!b)continue;const x1=a.x+W,y1=a.y+H/2,x2=b.x,y2=b.y+H/2,m=(x1+x2)/2;
  svg.append(s("path",{class:"e",d:"M"+x1+","+y1+"C"+m+","+y1+" "+m+","+y2+" "+x2+","+y2,"marker-end":"url(#ar)"}))}
 for(const id of ids){const n=by.get(id),p=pos.get(id),t=n.id+" "+n.title;
  const g=s("g",{class:"g",transform:"translate("+p.x+","+p.y+")"},s("title",{},t+" ("+n.status+")"),s("rect",{width:W,height:H,rx:6,fill:"var(--bg)",stroke:C(n.status),"stroke-width":n.status==="active"?2.5:1.5}),
   s("text",{x:10,y:H/2+4},t.length>26?t.slice(0,25)+"…":t));g.onclick=()=>go(id);svg.append(g)}
 $("graph").append(svg)})();
// checkpoints, newest first
const cps=X.checkpoints.slice().reverse();$("cps").append(cps.length?el("ul",{style:"padding-left:0"},...cps.map(c=>el("li",{style:"margin:0 0 8px"},el("span",{class:"id"},c.created_at.slice(0,16).replace("T"," ")+"  "),c.note))):el("p",{class:"mute"},"None."));
${live ? `setInterval(async()=>{try{const r=await fetch(${JSON.stringify(live.poll)});if(r.ok&&(await r.text())!==${JSON.stringify(live.version)})location.reload()}catch{}},2000);` : ""}
</script></body></html>
`;
}

/** Thread index for `autoplan serve`. */
export function indexHtml(threads: { id: string; title: string; status: string; goal: string; touched_at: string; locations?: string[] }[], bound: string | null): string {
  const rows = threads
    .map((t) => `<li><a href="/t/${esc(t.id)}">${esc(t.id)} ${esc(t.title)}</a>${t.id === bound ? " <b>(bound)</b>" : ""} <span class="m">[${esc(t.status)}] touched ${esc(t.touched_at.slice(0, 10))}</span>${t.locations?.length ? `<div class="m"><code>${t.locations.map(esc).join("</code> · <code>")}</code></div>` : ""}${t.goal ? `<div class="m">${esc(t.goal)}</div>` : ""}</li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>autoplan threads</title>
<style>:root{--bg:#fbfbfa;--fg:#1d1d1b;--m:#6b6b66;--a:#2f6fdb}@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#e8e8e4;--m:#9a9a94;--a:#6ea0ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:20px 16px}a{color:var(--a)}.m{color:var(--m)}li{margin:0 0 10px}ul{padding-left:18px}</style></head>
<body><main><h1>autoplan threads</h1>${rows ? `<ul>${rows}</ul>` : "<p class=m>No threads.</p>"}</main></body></html>`;
}
