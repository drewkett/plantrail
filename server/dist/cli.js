import{createRequire}from"module";const require=createRequire(import.meta.url);
import{parseArgs as H}from"node:util";import{chmodSync as K,mkdirSync as G,readFileSync as j,writeFileSync as W}from"node:fs";import{join as I}from"node:path";import{fileURLToPath as P}from"node:url";import{DatabaseSync as U}from"node:sqlite";import{mkdirSync as x}from"node:fs";import{homedir as M}from"node:os";import{join as L}from"node:path";function R(){return process.env.AUTOPLAN_HOME??L(M(),".autoplan")}var O=[`
  CREATE TABLE counters (name TEXT PRIMARY KEY, next INTEGER NOT NULL);
  INSERT INTO counters VALUES ('t', 1), ('n', 1);

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','parked','done')),
    created_at TEXT NOT NULL,
    touched_at TEXT NOT NULL
  );

  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    parent_id TEXT REFERENCES nodes(id),
    kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','question','finding','decision')),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','blocked','done','abandoned')),
    summary TEXT,
    body TEXT,
    refs TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX nodes_thread ON nodes(thread_id, status);
  CREATE INDEX nodes_parent ON nodes(parent_id);

  CREATE TABLE edges (
    from_id TEXT NOT NULL REFERENCES nodes(id),
    to_id TEXT NOT NULL REFERENCES nodes(id),
    type TEXT NOT NULL CHECK (type IN ('blocks','answers','derived_from','contradicts')),
    PRIMARY KEY (from_id, to_id, type)
  );
  CREATE INDEX edges_to ON edges(to_id, type);

  CREATE TABLE links (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    kind TEXT NOT NULL CHECK (kind IN ('repo','dir','url','ticket')),
    value TEXT NOT NULL,
    PRIMARY KEY (thread_id, kind, value)
  );
  CREATE INDEX links_value ON links(kind, value);

  CREATE TABLE checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    note TEXT NOT NULL,
    frontier_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    cwd TEXT,
    bound_at TEXT NOT NULL
  );
  CREATE INDEX sessions_cwd ON sessions(cwd, bound_at);

  CREATE VIRTUAL TABLE nodes_fts USING fts5(title, summary, body, content='nodes', content_rowid='rowid');
  CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, title, summary, body) VALUES (new.rowid, new.title, new.summary, new.body);
  END;
  CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, summary, body) VALUES ('delete', old.rowid, old.title, old.summary, old.body);
  END;
  CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, summary, body) VALUES ('delete', old.rowid, old.title, old.summary, old.body);
    INSERT INTO nodes_fts(rowid, title, summary, body) VALUES (new.rowid, new.title, new.summary, new.body);
  END;
  `];function A(r){let t=r;if(!t){let n=R();x(n,{recursive:!0}),t=L(n,"state.db")}let e=new U(t);return t!==":memory:"&&e.exec("PRAGMA journal_mode = WAL"),e.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"),F(e),e}function F(r){let{user_version:t}=r.prepare("PRAGMA user_version").get();for(let e=t;e<O.length;e++){r.exec("BEGIN");try{r.exec(O[e]),r.exec(`PRAGMA user_version = ${e+1}`),r.exec("COMMIT")}catch(n){throw r.exec("ROLLBACK"),n}}}import{execFileSync as B}from"node:child_process";import{realpathSync as X}from"node:fs";function S(r,t){try{return B("git",["-C",r,...t],{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:3e3}).trim()||null}catch{return null}}function f(r){let t=r;try{t=X(r)}catch{}let e=S(t,["rev-parse","--path-format=absolute","--git-common-dir"]);if(!e)return[{kind:"dir",value:t}];let n=[{kind:"repo",value:e}],i=S(t,["remote","get-url","origin"]);return i&&n.push({kind:"repo",value:i}),n}var h=class extends Error{},N=["done","abandoned"],m=class{bound=null;db;cwd;now;constructor(t,e=process.cwd(),n=()=>new Date){this.db=t,this.cwd=e,this.now=n}ts(){return this.now().toISOString()}nextId(t){let e=this.db.prepare("UPDATE counters SET next = next + 1 WHERE name = ? RETURNING next - 1 AS id").get(t);return`${t}${e.id}`}tx(t){this.db.exec("BEGIN IMMEDIATE");try{let e=t();return this.db.exec("COMMIT"),e}catch(e){throw this.db.exec("ROLLBACK"),e}}touch(t){this.db.prepare("UPDATE threads SET touched_at = ? WHERE id = ?").run(this.ts(),t)}getThread(t){let e=this.db.prepare("SELECT * FROM threads WHERE id = ?").get(t);if(!e)throw new h(`No thread ${t}`);return e}getNode(t){let e=this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(t);if(!e)throw new h(`No node ${t}`);return e}blockers(t){return this.db.prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.from_id
         WHERE e.to_id = ? AND e.type = 'blocks' AND n.status NOT IN ('done','abandoned')`).all(t)}children(t){return this.db.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY priority DESC, rowid").all(t)}depth(t){let e=0,n=t.parent_id;for(;n;)e++,n=this.db.prepare("SELECT parent_id FROM nodes WHERE id = ?").get(n).parent_id;return e}createThread(t,e,n=!0,i){return this.tx(()=>{let d=this.nextId("t"),u=this.ts();if(this.db.prepare("INSERT INTO threads (id, title, goal, created_at, touched_at) VALUES (?, ?, ?, ?, ?)").run(d,t,e,u,u),n)for(let c of f(this.cwd))this.addLink(d,c);return this.bindInner(d,i),this.getThread(d)})}addLink(t,e){this.db.prepare("INSERT OR IGNORE INTO links (thread_id, kind, value) VALUES (?, ?, ?)").run(t,e.kind,e.value)}listThreads(t="active"){let e=t==="all"?"SELECT * FROM threads ORDER BY touched_at DESC":"SELECT * FROM threads WHERE status = ? ORDER BY touched_at DESC",n=this.db.prepare(e);return t==="all"?n.all():n.all(t)}threadsForLocation(t){if(!t.length)return[];let e=t.map(()=>"(l.kind = ? AND l.value = ?)").join(" OR ");return this.db.prepare(`SELECT DISTINCT t.* FROM threads t JOIN links l ON l.thread_id = t.id
         WHERE t.status = 'active' AND (${e}) ORDER BY t.touched_at DESC`).all(...t.flatMap(n=>[n.kind,n.value]))}bindInner(t,e){this.bound=t,this.db.prepare(`INSERT INTO sessions (session_id, thread_id, cwd, bound_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET thread_id = excluded.thread_id, cwd = excluded.cwd, bound_at = excluded.bound_at`).run(e??`cwd:${this.cwd}`,t,this.cwd,this.ts()),this.touch(t)}bind(t,e){let n=this.getThread(t);return this.bindInner(n.id,e),n}current(){if(this.bound)return this.getThread(this.bound);let t=this.db.prepare(`SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
         WHERE s.cwd = ? AND t.status = 'active' ORDER BY s.bound_at DESC LIMIT 1`).get(this.cwd);if(t)return this.bound=t.thread_id,this.getThread(t.thread_id);let e=this.threadsForLocation(f(this.cwd));if(e.length===1)return this.bound=e[0].id,e[0];let n=e.length?`Linked threads here: ${e.map(i=>`${i.id} "${i.title}"`).join(", ")}.`:"Use `autoplan threads` or `autoplan create`.";throw new h(`No thread bound. Run \`autoplan bind <thread_id>\`. ${n}`)}add(t){let e=this.current();return this.tx(()=>{let n=this.ts(),i=[],d=o=>{let s=/^#(\d+)$/.exec(o);if(s){let p=i[Number(s[1])];if(!p)throw new h(`Reference ${o} must point to an earlier item in this call`);return p}let a=this.getNode(o);if(a.thread_id!==e.id)throw new h(`${o} belongs to thread ${a.thread_id}`);return a.id},u=this.db.prepare(`INSERT INTO nodes (id, thread_id, parent_id, kind, title, body, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),c=this.db.prepare("INSERT OR IGNORE INTO edges (from_id, to_id, type) VALUES (?, ?, 'blocks')"),l=[];for(let o of t){let s=this.nextId("n");i.push(s),u.run(s,e.id,o.parent?d(o.parent):null,o.kind??"task",o.title,o.body??null,o.priority??0,n,n);for(let a of o.blocked_by??[])c.run(d(a),s);for(let a of o.blocks??[])l.push([s,a])}for(let[o,s]of l){let a=d(s);if(a===o)throw new h("A node cannot block itself");c.run(o,a)}return this.touch(e.id),i.map(o=>this.getNode(o))})}start(t){let e=this.getNode(t);if(N.includes(e.status))throw new h(`${t} is ${e.status}; reopen it with update first`);let n=this.blockers(t);if(n.length)throw new h(`${t} is blocked by ${n.map(i=>`${i.id} "${i.title}"`).join(", ")}`);if(e.status==="blocked")throw new h(`${t} is marked blocked; update its status to open first`);return this.tx(()=>{let i=this.ts(),d=this.db.prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active' AND id != ?").all(e.thread_id,t).map(u=>u.id);return this.db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE thread_id = ? AND status = 'active' AND id != ?").run(i,e.thread_id,t),this.db.prepare("UPDATE nodes SET status = 'active', updated_at = ? WHERE id = ?").run(i,t),this.touch(e.thread_id),{node:this.getNode(t),demoted:d}})}done(t,e,n){if(!e?.trim())throw new h("done requires a non-empty summary");let i=this.getNode(t);if(i.status==="done")throw new h(`${t} is already done`);let d=this.children(t).filter(u=>!N.includes(u.status));if(d.length)throw new h(`${t} has unresolved children: ${d.map(u=>u.id).join(", ")}`);return this.tx(()=>{let u=this.ts();this.db.prepare("UPDATE nodes SET status = 'done', summary = ?, refs = ?, updated_at = ? WHERE id = ?").run(e.trim(),n?.length?JSON.stringify(n):null,u,t);let c=this.releaseDependents(t,u);return this.touch(i.thread_id),{node:this.getNode(t),unblocked:c,parentReady:this.parentReady(i.parent_id)}})}releaseDependents(t,e){let n=this.db.prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.to_id
         WHERE e.from_id = ? AND e.type = 'blocks' AND n.status NOT IN ('done','abandoned')`).all(t),i=[];for(let d of n)this.blockers(d.id).length||(d.status==="blocked"&&this.db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE id = ?").run(e,d.id),i.push(this.getNode(d.id)));return i}parentReady(t){if(!t)return null;let e=this.getNode(t);return N.includes(e.status)?null:this.children(t).every(n=>N.includes(n.status))?e:null}update(t,e){let n=this.getNode(t);if(e.status==="done")throw new h("Use done(id, summary) to complete a node");if(e.status==="abandoned"&&!(e.summary??n.summary)?.trim())throw new h("Abandoning requires a summary explaining why");if(e.status==="active")throw new h("Use start(id) to activate a node");let i=[],d=[];for(let u of["title","body","status","priority","summary","kind"])e[u]!==void 0&&(i.push(`${u} = ?`),d.push(e[u]));if(!i.length)throw new h("No fields to update");return this.tx(()=>{let u=this.ts();this.db.prepare(`UPDATE nodes SET ${i.join(", ")}, updated_at = ? WHERE id = ?`).run(...d,u,t);let c=e.status==="abandoned"?this.releaseDependents(t,u):[];return this.touch(n.thread_id),{node:this.getNode(t),unblocked:c}})}nextOptions(t=3,e){let n=e??this.current().id,i=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status = 'open' AND kind IN ('task','question')").all(n),d=this.now().getTime(),u=[];for(let c of i){if(this.blockers(c.id).length)continue;let l=this.children(c.id).filter(k=>!N.includes(k.status)).length,o=this.depth(c),s=Math.min(7,(d-Date.parse(c.updated_at))/864e5),a=l===0?5:0,p=c.priority*10+a+o*1.5+s*.5,y=[c.priority?`p${c.priority}`:null,l?`${l} open children`:"leaf",o?`depth ${o}`:null,s>=1?`idle ${Math.floor(s)}d`:null].filter(Boolean).join(", ");u.push({node:c,score:Math.round(p*10)/10,why:y})}return u.sort((c,l)=>l.score-c.score||c.node.created_at.localeCompare(l.node.created_at)||c.node.id.localeCompare(l.node.id,void 0,{numeric:!0})),u.slice(0,t)}checkpoint(t){if(!t?.trim())throw new h("checkpoint requires a note");let e=this.current(),i={active:this.db.prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active'").all(e.id).map(u=>u.id),next:this.nextOptions(5,e.id).map(u=>u.node.id)},d=this.db.prepare("INSERT INTO checkpoints (thread_id, note, frontier_json, created_at) VALUES (?, ?, ?, ?)").run(e.id,t.trim(),JSON.stringify(i),this.ts());return this.touch(e.id),{id:Number(d.lastInsertRowid)}}statusText(t){let e=t?this.getThread(t):this.current(),n=Object.fromEntries(this.db.prepare("SELECT status, COUNT(*) AS c FROM nodes WHERE thread_id = ? GROUP BY status").all(e.id).map(s=>[s.status,s.c])),i=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status = 'active'").all(e.id),d=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status IN ('open','blocked') ORDER BY priority DESC").all(e.id).filter(s=>s.status==="blocked"||this.blockers(s.id).length),u=this.db.prepare("SELECT note, created_at FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(e.id),c=[`[autoplan] ${e.id} "${e.title}" (${e.status})`];e.goal&&c.push(`Goal: ${_(e.goal,200)}`);let l=["open","active","blocked","done","abandoned"].filter(s=>n[s]).map(s=>`${n[s]} ${s}`).join(", ");c.push(`Nodes: ${l||"none"}`),i.length&&c.push(`Active: ${i.map(g).join("; ")}`);let o=this.nextOptions(3,e.id);if(o.length){c.push("Next:");for(let s of o)c.push(`  ${g(s.node)}`)}if(d.length){c.push("Blocked:");for(let s of d.slice(0,5)){let a=this.blockers(s.id).map(p=>p.id);c.push(`  ${g(s)}${a.length?` \u2190 ${a.join(", ")}`:""}`)}d.length>5&&c.push(`  \u2026${d.length-5} more`)}return u&&c.push(`Last checkpoint (${u.created_at.slice(0,16)}): ${_(u.note,400)}`),c.join(`
`)}getText(t,e=0){let n=this.getNode(t),i=[`${n.id} [${n.kind}/${n.status}${n.priority?` p${n.priority}`:""}] ${n.title}`,`thread ${n.thread_id}${n.parent_id?`, parent ${n.parent_id}`:""}, updated ${n.updated_at.slice(0,16)}`];n.body&&i.push(`Body: ${n.body}`),n.summary&&i.push(`Summary: ${n.summary}`),n.refs&&i.push(`Refs: ${JSON.parse(n.refs).join(", ")}`);let d=this.blockers(t);d.length&&i.push(`Blocked by: ${d.map(g).join("; ")}`);let u=this.db.prepare("SELECT to_id FROM edges WHERE from_id = ? AND type = 'blocks'").all(t);u.length&&i.push(`Blocks: ${u.map(l=>l.to_id).join(", ")}`);let c=(l,o,s)=>{for(let a of this.children(l))i.push(`${s}${g(a)}${a.summary?` \u2014 ${_(a.summary,120)}`:""}`),o>1&&c(a.id,o-1,s+"  ")};if(e>0)i.push("Children:"),c(t,e,"  ");else{let l=this.children(t).length;l&&i.push(`${l} children (use depth>0 to list)`)}return i.join(`
`)}resume(t){let e=f(this.cwd),n=this.threadsForLocation(e);if(t){let i=this.db.prepare(`SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
           WHERE s.session_id = ? AND t.status = 'active'`).get(t);if(i)return this.bindInner(i.thread_id,t),this.statusText(i.thread_id)}return n.length===1?(this.bindInner(n[0].id,t),this.statusText(n[0].id)):n.length>1?["[autoplan] Multiple active threads are linked to this location. Ask the user which one, then run `autoplan bind <thread_id>`:",...n.map(i=>`  ${i.id} "${i.title}" (touched ${i.touched_at.slice(0,10)})`)].join(`
`):""}};function _(r,t){return r.length>t?r.slice(0,t-1)+"\u2026":r}function g(r){return`${r.id} ${r.kind==="task"?"":`(${r.kind}) `}${r.title}`}var $=`usage: autoplan <command> [args] [--cwd DIR] [--thread ID]
  status                                   compact view of the bound thread
  threads [--all]                          list threads (* = bound here)
  create TITLE --goal G [--no-link]        create thread, link this dir, bind
  bind THREAD_ID                           bind this dir to a thread
  add TITLE [--kind K] [--parent ID] [--body B] [--priority N] [--blocks ID,..] [--blocked-by ID,..]
  add -                                    add items from a JSON array on stdin
                                           ({title, kind?, parent?, body?, priority?, blocks?, blocked_by?};
                                            "#i" refers to the i-th item of the same array)
  start ID                                 mark active (refuses if blocked)
  done ID --summary S [--ref R]...         complete; summary required
  update ID [--title T] [--body B] [--status open|blocked|abandoned] [--priority N] [--summary S] [--kind K]
  next [-n N]                              ranked options to work on next
  get ID [--depth D]                       full node detail (+ subtree)
  checkpoint NOTE                          save handoff note
  resume [--session ID] [--hook]           SessionStart: bind + print status
                                           (--hook: read {cwd, session_id} JSON from stdin)`,D=["task","question","finding","decision"];function v(){return j(0,"utf8")}function Y(){try{return JSON.parse(v())}catch{return{}}}function J(){try{let r=I(R(),"bin");G(r,{recursive:!0});let t=I(r,"autoplan");W(t,`#!/bin/sh
exec node "${P(import.meta.url)}" "$@"
`),K(t,493)}catch{}}var T=r=>`${r.id} [${r.kind}/${r.status}] ${r.title}`;function E(r,t){if(!r)throw new h(`Missing ${t}. Run 'autoplan help' for usage.`);return r}function w(r){if(r!==void 0&&!D.includes(r))throw new h(`--kind must be one of ${D.join(", ")}`);return r}function b(r,t){if(r===void 0)return;let e=Number(r);if(!Number.isInteger(e))throw new h(`${t} must be an integer`);return e}var C=r=>r?r.split(",").map(t=>t.trim()).filter(Boolean):void 0;function V(r){let t;try{t=JSON.parse(r)}catch(n){throw new h(`stdin is not valid JSON: ${n.message}`)}Array.isArray(t)||(t=[t]);let e=t;if(!e.length)throw new h("No items to add");for(let[n,i]of e.entries()){if(!i||typeof i.title!="string"||!i.title.trim())throw new h(`Item #${n} needs a title`);w(i.kind)}return e}function q(r=process.argv.slice(2)){let{values:t,positionals:e}=H({args:r,allowPositionals:!0,options:{cwd:{type:"string"},session:{type:"string"},thread:{type:"string"},hook:{type:"boolean"},all:{type:"boolean"},goal:{type:"string"},"no-link":{type:"boolean"},kind:{type:"string"},parent:{type:"string"},body:{type:"string"},priority:{type:"string"},blocks:{type:"string"},"blocked-by":{type:"string"},summary:{type:"string"},ref:{type:"string",multiple:!0},title:{type:"string"},status:{type:"string"},n:{type:"string",short:"n"},depth:{type:"string"}}}),[n,...i]=e,d=i.join(" ")||void 0,u=t.cwd,c=t.session;if(t.hook){let s=Y();u??=s.cwd,c??=s.session_id}let l=new m(A(),u??process.cwd());t.thread&&(l.bound=l.getThread(t.thread).id);let o=s=>console.log(s);switch(n){case"resume":{J();let s=l.resume(c);if(!s)return 0;if(t.hook){let a=s.split(`
`),p=a.find(k=>k.startsWith("Nodes:")),y=[a[0].replace(/^\[autoplan\] /,"autoplan: resumed "),p?.replace(/^Nodes: /,"")].filter(Boolean).join(" \u2014 ");o(JSON.stringify({systemMessage:y,hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:s}}))}else o(s);return 0}case"status":return o(l.statusText()),0;case"threads":{let s=l.listThreads(t.all?"all":"active"),a=null;try{a=l.current().id}catch{}s.length||o("No threads.");for(let p of s)o(`${p.id}${p.id===a?"*":""} [${p.status}] ${p.title} (touched ${p.touched_at.slice(0,10)})`);return 0}case"create":{let s=l.createThread(E(d,"TITLE"),E(t.goal,"--goal"),!t["no-link"]);return o(`Created and bound ${s.id} "${s.title}".`),0}case"bind":return l.bind(E(d,"THREAD_ID")),o(l.statusText()),0;case"add":{let s=d==="-"?V(v()):[{title:E(d,"TITLE (or '-' for JSON on stdin)"),kind:w(t.kind),parent:t.parent,body:t.body,priority:b(t.priority,"--priority"),blocks:C(t.blocks),blocked_by:C(t["blocked-by"])}];for(let a of l.add(s))o(T(a));return 0}case"start":{let{node:s,demoted:a}=l.start(E(d,"ID"));return o(`Started ${T(s)}`),a.length&&o(`Returned to open: ${a.join(", ")}`),0}case"done":{let{node:s,unblocked:a,parentReady:p}=l.done(E(d,"ID"),E(t.summary,"--summary"),t.ref);return o(`Done ${T(s)}`),a.length&&o(`Unblocked: ${a.map(T).join("; ")}`),p&&o(`All children of ${p.id} "${p.title}" are resolved \u2014 consider: autoplan done ${p.id}`),0}case"update":{if(t.status!==void 0&&!["open","blocked","abandoned"].includes(t.status))throw new h("--status must be open, blocked, or abandoned (use start/done otherwise)");let{node:s,unblocked:a}=l.update(E(d,"ID"),{title:t.title,body:t.body,status:t.status,priority:b(t.priority,"--priority"),summary:t.summary,kind:w(t.kind)});return o(`Updated ${T(s)}`),a.length&&o(`Unblocked: ${a.map(T).join("; ")}`),0}case"next":{let s=l.nextOptions(b(t.n,"-n")??3);s.length||o("Nothing open and unblocked.");for(let a of s)o(`${T(a.node)}  (score ${a.score}: ${a.why})`);return 0}case"get":return o(l.getText(E(d,"ID"),b(t.depth,"--depth")??0)),0;case"checkpoint":{let{id:s}=l.checkpoint(E(d,"NOTE"));return o(`Checkpoint #${s} saved.`),0}case"help":case void 0:return o($),n?0:2;default:return console.error(`Unknown command '${n}'.
${$}`),2}}try{process.exitCode=q()}catch(r){if(!(r instanceof h)&&!(r instanceof TypeError&&"code"in r))throw r;console.error(r.message),process.exitCode=1}
