import{createRequire}from"module";const require=createRequire(import.meta.url);
import{parseArgs as H}from"node:util";import{chmodSync as K,mkdirSync as G,readFileSync as j,writeFileSync as W}from"node:fs";import{join as A}from"node:path";import{fileURLToPath as P}from"node:url";import{DatabaseSync as U}from"node:sqlite";import{mkdirSync as x}from"node:fs";import{homedir as M}from"node:os";import{join as w}from"node:path";function y(){return process.env.AUTOPLAN_HOME??w(M(),".autoplan")}var _=[`
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
  `];function O(r){let t=r;if(!t){let n=y();x(n,{recursive:!0}),t=w(n,"state.db")}let e=new U(t);return t!==":memory:"&&e.exec("PRAGMA journal_mode = WAL"),e.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"),F(e),e}function F(r){let{user_version:t}=r.prepare("PRAGMA user_version").get();for(let e=t;e<_.length;e++){r.exec("BEGIN");try{r.exec(_[e]),r.exec(`PRAGMA user_version = ${e+1}`),r.exec("COMMIT")}catch(n){throw r.exec("ROLLBACK"),n}}}import{execFileSync as B}from"node:child_process";import{realpathSync as X}from"node:fs";function L(r,t){try{return B("git",["-C",r,...t],{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:3e3}).trim()||null}catch{return null}}function m(r){let t=r;try{t=X(r)}catch{}let e=L(t,["rev-parse","--path-format=absolute","--git-common-dir"]);if(!e)return[{kind:"dir",value:t}];let n=[{kind:"repo",value:e}],s=L(t,["remote","get-url","origin"]);return s&&n.push({kind:"repo",value:s}),n}var h=class extends Error{},N=["done","abandoned"],f=class{bound=null;db;cwd;now;constructor(t,e=process.cwd(),n=()=>new Date){this.db=t,this.cwd=e,this.now=n}ts(){return this.now().toISOString()}nextId(t){let e=this.db.prepare("UPDATE counters SET next = next + 1 WHERE name = ? RETURNING next - 1 AS id").get(t);return`${t}${e.id}`}tx(t){this.db.exec("BEGIN IMMEDIATE");try{let e=t();return this.db.exec("COMMIT"),e}catch(e){throw this.db.exec("ROLLBACK"),e}}touch(t){this.db.prepare("UPDATE threads SET touched_at = ? WHERE id = ?").run(this.ts(),t)}getThread(t){let e=this.db.prepare("SELECT * FROM threads WHERE id = ?").get(t);if(!e)throw new h(`No thread ${t}`);return e}getNode(t){let e=this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(t);if(!e)throw new h(`No node ${t}`);return e}blockers(t){return this.db.prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.from_id
         WHERE e.to_id = ? AND e.type = 'blocks' AND n.status NOT IN ('done','abandoned')`).all(t)}children(t){return this.db.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY priority DESC, rowid").all(t)}depth(t){let e=0,n=t.parent_id;for(;n;)e++,n=this.db.prepare("SELECT parent_id FROM nodes WHERE id = ?").get(n).parent_id;return e}createThread(t,e,n=!0,s){return this.tx(()=>{let d=this.nextId("t"),a=this.ts();if(this.db.prepare("INSERT INTO threads (id, title, goal, created_at, touched_at) VALUES (?, ?, ?, ?, ?)").run(d,t,e,a,a),n)for(let u of m(this.cwd))this.addLink(d,u);return this.bindInner(d,s),this.getThread(d)})}addLink(t,e){this.db.prepare("INSERT OR IGNORE INTO links (thread_id, kind, value) VALUES (?, ?, ?)").run(t,e.kind,e.value)}listThreads(t="active"){let e=t==="all"?"SELECT * FROM threads ORDER BY touched_at DESC":"SELECT * FROM threads WHERE status = ? ORDER BY touched_at DESC",n=this.db.prepare(e);return t==="all"?n.all():n.all(t)}threadsForLocation(t){if(!t.length)return[];let e=t.map(()=>"(l.kind = ? AND l.value = ?)").join(" OR ");return this.db.prepare(`SELECT DISTINCT t.* FROM threads t JOIN links l ON l.thread_id = t.id
         WHERE t.status = 'active' AND (${e}) ORDER BY t.touched_at DESC`).all(...t.flatMap(n=>[n.kind,n.value]))}bindInner(t,e){this.bound=t,this.db.prepare(`INSERT INTO sessions (session_id, thread_id, cwd, bound_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET thread_id = excluded.thread_id, cwd = excluded.cwd, bound_at = excluded.bound_at`).run(e??`cwd:${this.cwd}`,t,this.cwd,this.ts()),this.touch(t)}bind(t,e){let n=this.getThread(t);return this.bindInner(n.id,e),n}current(){if(this.bound)return this.getThread(this.bound);let t=this.db.prepare(`SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
         WHERE s.cwd = ? AND t.status = 'active' ORDER BY s.bound_at DESC LIMIT 1`).get(this.cwd);if(t)return this.bound=t.thread_id,this.getThread(t.thread_id);let e=this.threadsForLocation(m(this.cwd));if(e.length===1)return this.bound=e[0].id,e[0];let n=e.length?`Linked threads here: ${e.map(s=>`${s.id} "${s.title}"`).join(", ")}.`:"Use `autoplan threads` or `autoplan create`.";throw new h(`No thread bound. Run \`autoplan bind <thread_id>\`. ${n}`)}add(t){let e=this.current();return this.tx(()=>{let n=this.ts(),s=[],d=o=>{let i=/^#(\d+)$/.exec(o);if(i){let p=s[Number(i[1])];if(!p)throw new h(`Reference ${o} must point to an earlier item in this call`);return p}let c=this.getNode(o);if(c.thread_id!==e.id)throw new h(`${o} belongs to thread ${c.thread_id}`);return c.id},a=this.db.prepare(`INSERT INTO nodes (id, thread_id, parent_id, kind, title, body, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),u=this.db.prepare("INSERT OR IGNORE INTO edges (from_id, to_id, type) VALUES (?, ?, 'blocks')"),l=[];for(let o of t){let i=this.nextId("n");s.push(i),a.run(i,e.id,o.parent?d(o.parent):null,o.kind??"task",o.title,o.body??null,o.priority??0,n,n);for(let c of o.blocked_by??[])u.run(d(c),i);for(let c of o.blocks??[])l.push([i,c])}for(let[o,i]of l){let c=d(i);if(c===o)throw new h("A node cannot block itself");u.run(o,c)}return this.touch(e.id),s.map(o=>this.getNode(o))})}start(t){let e=this.getNode(t);if(N.includes(e.status))throw new h(`${t} is ${e.status}; reopen it with update first`);let n=this.blockers(t);if(n.length)throw new h(`${t} is blocked by ${n.map(s=>`${s.id} "${s.title}"`).join(", ")}`);if(e.status==="blocked")throw new h(`${t} is marked blocked; update its status to open first`);return this.tx(()=>{let s=this.ts(),d=this.db.prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active' AND id != ?").all(e.thread_id,t).map(a=>a.id);return this.db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE thread_id = ? AND status = 'active' AND id != ?").run(s,e.thread_id,t),this.db.prepare("UPDATE nodes SET status = 'active', updated_at = ? WHERE id = ?").run(s,t),this.touch(e.thread_id),{node:this.getNode(t),demoted:d}})}done(t,e,n){if(!e?.trim())throw new h("done requires a non-empty summary");let s=this.getNode(t);if(s.status==="done")throw new h(`${t} is already done`);let d=this.children(t).filter(a=>!N.includes(a.status));if(d.length)throw new h(`${t} has unresolved children: ${d.map(a=>a.id).join(", ")}`);return this.tx(()=>{let a=this.ts();this.db.prepare("UPDATE nodes SET status = 'done', summary = ?, refs = ?, updated_at = ? WHERE id = ?").run(e.trim(),n?.length?JSON.stringify(n):null,a,t);let u=this.releaseDependents(t,a);return this.touch(s.thread_id),{node:this.getNode(t),unblocked:u,parentReady:this.parentReady(s.parent_id)}})}releaseDependents(t,e){let n=this.db.prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.to_id
         WHERE e.from_id = ? AND e.type = 'blocks' AND n.status NOT IN ('done','abandoned')`).all(t),s=[];for(let d of n)this.blockers(d.id).length||(d.status==="blocked"&&this.db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE id = ?").run(e,d.id),s.push(this.getNode(d.id)));return s}parentReady(t){if(!t)return null;let e=this.getNode(t);return N.includes(e.status)?null:this.children(t).every(n=>N.includes(n.status))?e:null}update(t,e){let n=this.getNode(t);if(e.status==="done")throw new h("Use done(id, summary) to complete a node");if(e.status==="abandoned"&&!(e.summary??n.summary)?.trim())throw new h("Abandoning requires a summary explaining why");if(e.status==="active")throw new h("Use start(id) to activate a node");let s=[],d=[];for(let a of["title","body","status","priority","summary","kind"])e[a]!==void 0&&(s.push(`${a} = ?`),d.push(e[a]));if(!s.length)throw new h("No fields to update");return this.tx(()=>{let a=this.ts();this.db.prepare(`UPDATE nodes SET ${s.join(", ")}, updated_at = ? WHERE id = ?`).run(...d,a,t);let u=e.status==="abandoned"?this.releaseDependents(t,a):[];return this.touch(n.thread_id),{node:this.getNode(t),unblocked:u}})}nextOptions(t=3,e){let n=e??this.current().id,s=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status = 'open' AND kind IN ('task','question')").all(n),d=this.now().getTime(),a=[];for(let u of s){if(this.blockers(u.id).length)continue;let l=this.children(u.id).filter(v=>!N.includes(v.status)).length,o=this.depth(u),i=Math.min(7,(d-Date.parse(u.updated_at))/864e5),c=l===0?5:0,p=u.priority*10+c+o*1.5+i*.5,C=[u.priority?`p${u.priority}`:null,l?`${l} open children`:"leaf",o?`depth ${o}`:null,i>=1?`idle ${Math.floor(i)}d`:null].filter(Boolean).join(", ");a.push({node:u,score:Math.round(p*10)/10,why:C})}return a.sort((u,l)=>l.score-u.score||u.node.created_at.localeCompare(l.node.created_at)||u.node.id.localeCompare(l.node.id,void 0,{numeric:!0})),a.slice(0,t)}checkpoint(t){if(!t?.trim())throw new h("checkpoint requires a note");let e=this.current(),s={active:this.db.prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active'").all(e.id).map(a=>a.id),next:this.nextOptions(5,e.id).map(a=>a.node.id)},d=this.db.prepare("INSERT INTO checkpoints (thread_id, note, frontier_json, created_at) VALUES (?, ?, ?, ?)").run(e.id,t.trim(),JSON.stringify(s),this.ts());return this.touch(e.id),{id:Number(d.lastInsertRowid)}}statusText(t){let e=t?this.getThread(t):this.current(),n=Object.fromEntries(this.db.prepare("SELECT status, COUNT(*) AS c FROM nodes WHERE thread_id = ? GROUP BY status").all(e.id).map(i=>[i.status,i.c])),s=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status = 'active'").all(e.id),d=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status IN ('open','blocked') ORDER BY priority DESC").all(e.id).filter(i=>i.status==="blocked"||this.blockers(i.id).length),a=this.db.prepare("SELECT note, created_at FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(e.id),u=[`[autoplan] ${e.id} "${e.title}" (${e.status})`];e.goal&&u.push(`Goal: ${R(e.goal,200)}`);let l=["open","active","blocked","done","abandoned"].filter(i=>n[i]).map(i=>`${n[i]} ${i}`).join(", ");u.push(`Nodes: ${l||"none"}`),s.length&&u.push(`Active: ${s.map(g).join("; ")}`);let o=this.nextOptions(3,e.id);if(o.length){u.push("Next:");for(let i of o)u.push(`  ${g(i.node)}`)}if(d.length){u.push("Blocked:");for(let i of d.slice(0,5)){let c=this.blockers(i.id).map(p=>p.id);u.push(`  ${g(i)}${c.length?` \u2190 ${c.join(", ")}`:""}`)}d.length>5&&u.push(`  \u2026${d.length-5} more`)}return a&&u.push(`Last checkpoint (${a.created_at.slice(0,16)}): ${R(a.note,400)}`),u.join(`
`)}getText(t,e=0){let n=this.getNode(t),s=[`${n.id} [${n.kind}/${n.status}${n.priority?` p${n.priority}`:""}] ${n.title}`,`thread ${n.thread_id}${n.parent_id?`, parent ${n.parent_id}`:""}, updated ${n.updated_at.slice(0,16)}`];n.body&&s.push(`Body: ${n.body}`),n.summary&&s.push(`Summary: ${n.summary}`),n.refs&&s.push(`Refs: ${JSON.parse(n.refs).join(", ")}`);let d=this.blockers(t);d.length&&s.push(`Blocked by: ${d.map(g).join("; ")}`);let a=this.db.prepare("SELECT to_id FROM edges WHERE from_id = ? AND type = 'blocks'").all(t);a.length&&s.push(`Blocks: ${a.map(l=>l.to_id).join(", ")}`);let u=(l,o,i)=>{for(let c of this.children(l))s.push(`${i}${g(c)}${c.summary?` \u2014 ${R(c.summary,120)}`:""}`),o>1&&u(c.id,o-1,i+"  ")};if(e>0)s.push("Children:"),u(t,e,"  ");else{let l=this.children(t).length;l&&s.push(`${l} children (use depth>0 to list)`)}return s.join(`
`)}resume(t){let e=m(this.cwd),n=this.threadsForLocation(e);if(t){let s=this.db.prepare(`SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
           WHERE s.session_id = ? AND t.status = 'active'`).get(t);if(s)return this.bindInner(s.thread_id,t),this.statusText(s.thread_id)}return n.length===1?(this.bindInner(n[0].id,t),this.statusText(n[0].id)):n.length>1?["[autoplan] Multiple active threads are linked to this location. Ask the user which one, then run `autoplan bind <thread_id>`:",...n.map(s=>`  ${s.id} "${s.title}" (touched ${s.touched_at.slice(0,10)})`)].join(`
`):""}};function R(r,t){return r.length>t?r.slice(0,t-1)+"\u2026":r}function g(r){return`${r.id} ${r.kind==="task"?"":`(${r.kind}) `}${r.title}`}var I=`usage: autoplan <command> [args] [--cwd DIR] [--thread ID]
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
                                           (--hook: read {cwd, session_id} JSON from stdin)`,S=["task","question","finding","decision"];function D(){return j(0,"utf8")}function Y(){try{return JSON.parse(D())}catch{return{}}}function J(){try{let r=A(y(),"bin");G(r,{recursive:!0});let t=A(r,"autoplan");W(t,`#!/bin/sh
exec node "${P(import.meta.url)}" "$@"
`),K(t,493)}catch{}}var T=r=>`${r.id} [${r.kind}/${r.status}] ${r.title}`;function E(r,t){if(!r)throw new h(`Missing ${t}. Run 'autoplan help' for usage.`);return r}function k(r){if(r!==void 0&&!S.includes(r))throw new h(`--kind must be one of ${S.join(", ")}`);return r}function b(r,t){if(r===void 0)return;let e=Number(r);if(!Number.isInteger(e))throw new h(`${t} must be an integer`);return e}var $=r=>r?r.split(",").map(t=>t.trim()).filter(Boolean):void 0;function V(r){let t;try{t=JSON.parse(r)}catch(n){throw new h(`stdin is not valid JSON: ${n.message}`)}Array.isArray(t)||(t=[t]);let e=t;if(!e.length)throw new h("No items to add");for(let[n,s]of e.entries()){if(!s||typeof s.title!="string"||!s.title.trim())throw new h(`Item #${n} needs a title`);k(s.kind)}return e}function q(r=process.argv.slice(2)){let{values:t,positionals:e}=H({args:r,allowPositionals:!0,options:{cwd:{type:"string"},session:{type:"string"},thread:{type:"string"},hook:{type:"boolean"},all:{type:"boolean"},goal:{type:"string"},"no-link":{type:"boolean"},kind:{type:"string"},parent:{type:"string"},body:{type:"string"},priority:{type:"string"},blocks:{type:"string"},"blocked-by":{type:"string"},summary:{type:"string"},ref:{type:"string",multiple:!0},title:{type:"string"},status:{type:"string"},n:{type:"string",short:"n"},depth:{type:"string"}}}),[n,...s]=e,d=s.join(" ")||void 0,a=t.cwd,u=t.session;if(t.hook){let i=Y();a??=i.cwd,u??=i.session_id}let l=new f(O(),a??process.cwd());t.thread&&(l.bound=l.getThread(t.thread).id);let o=i=>console.log(i);switch(n){case"resume":{J();let i=l.resume(u);return i&&o(i),0}case"status":return o(l.statusText()),0;case"threads":{let i=l.listThreads(t.all?"all":"active"),c=null;try{c=l.current().id}catch{}i.length||o("No threads.");for(let p of i)o(`${p.id}${p.id===c?"*":""} [${p.status}] ${p.title} (touched ${p.touched_at.slice(0,10)})`);return 0}case"create":{let i=l.createThread(E(d,"TITLE"),E(t.goal,"--goal"),!t["no-link"]);return o(`Created and bound ${i.id} "${i.title}".`),0}case"bind":return l.bind(E(d,"THREAD_ID")),o(l.statusText()),0;case"add":{let i=d==="-"?V(D()):[{title:E(d,"TITLE (or '-' for JSON on stdin)"),kind:k(t.kind),parent:t.parent,body:t.body,priority:b(t.priority,"--priority"),blocks:$(t.blocks),blocked_by:$(t["blocked-by"])}];for(let c of l.add(i))o(T(c));return 0}case"start":{let{node:i,demoted:c}=l.start(E(d,"ID"));return o(`Started ${T(i)}`),c.length&&o(`Returned to open: ${c.join(", ")}`),0}case"done":{let{node:i,unblocked:c,parentReady:p}=l.done(E(d,"ID"),E(t.summary,"--summary"),t.ref);return o(`Done ${T(i)}`),c.length&&o(`Unblocked: ${c.map(T).join("; ")}`),p&&o(`All children of ${p.id} "${p.title}" are resolved \u2014 consider: autoplan done ${p.id}`),0}case"update":{if(t.status!==void 0&&!["open","blocked","abandoned"].includes(t.status))throw new h("--status must be open, blocked, or abandoned (use start/done otherwise)");let{node:i,unblocked:c}=l.update(E(d,"ID"),{title:t.title,body:t.body,status:t.status,priority:b(t.priority,"--priority"),summary:t.summary,kind:k(t.kind)});return o(`Updated ${T(i)}`),c.length&&o(`Unblocked: ${c.map(T).join("; ")}`),0}case"next":{let i=l.nextOptions(b(t.n,"-n")??3);i.length||o("Nothing open and unblocked.");for(let c of i)o(`${T(c.node)}  (score ${c.score}: ${c.why})`);return 0}case"get":return o(l.getText(E(d,"ID"),b(t.depth,"--depth")??0)),0;case"checkpoint":{let{id:i}=l.checkpoint(E(d,"NOTE"));return o(`Checkpoint #${i} saved.`),0}case"help":case void 0:return o(I),n?0:2;default:return console.error(`Unknown command '${n}'.
${I}`),2}}try{process.exitCode=q()}catch(r){if(!(r instanceof h)&&!(r instanceof TypeError&&"code"in r))throw r;console.error(r.message),process.exitCode=1}
