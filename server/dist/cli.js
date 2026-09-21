import{createRequire}from"module";const require=createRequire(import.meta.url);
import{parseArgs as $}from"node:util";import{readFileSync as C}from"node:fs";import{DatabaseSync as O}from"node:sqlite";import{mkdirSync as w}from"node:fs";import{homedir as k}from"node:os";import{join as R}from"node:path";function A(){return process.env.AUTOPLAN_HOME??R(k(),".autoplan")}var f=[`
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
  `];function b(d){let t=d;if(!t){let n=A();w(n,{recursive:!0}),t=R(n,"state.db")}let e=new O(t);return t!==":memory:"&&e.exec("PRAGMA journal_mode = WAL"),e.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"),S(e),e}function S(d){let{user_version:t}=d.prepare("PRAGMA user_version").get();for(let e=t;e<f.length;e++){d.exec("BEGIN");try{d.exec(f[e]),d.exec(`PRAGMA user_version = ${e+1}`),d.exec("COMMIT")}catch(n){throw d.exec("ROLLBACK"),n}}}import{execFileSync as I}from"node:child_process";import{realpathSync as D}from"node:fs";function _(d,t){try{return I("git",["-C",d,...t],{encoding:"utf8",stdio:["ignore","pipe","ignore"],timeout:3e3}).trim()||null}catch{return null}}function N(d){let t=d;try{t=D(d)}catch{}let e=_(t,["rev-parse","--path-format=absolute","--git-common-dir"]);if(!e)return[{kind:"dir",value:t}];let n=[{kind:"repo",value:e}],s=_(t,["remote","get-url","origin"]);return s&&n.push({kind:"repo",value:s}),n}var u=class extends Error{},p=["done","abandoned"],g=class{bound=null;db;cwd;now;constructor(t,e=process.cwd(),n=()=>new Date){this.db=t,this.cwd=e,this.now=n}ts(){return this.now().toISOString()}nextId(t){let e=this.db.prepare("UPDATE counters SET next = next + 1 WHERE name = ? RETURNING next - 1 AS id").get(t);return`${t}${e.id}`}tx(t){this.db.exec("BEGIN IMMEDIATE");try{let e=t();return this.db.exec("COMMIT"),e}catch(e){throw this.db.exec("ROLLBACK"),e}}touch(t){this.db.prepare("UPDATE threads SET touched_at = ? WHERE id = ?").run(this.ts(),t)}getThread(t){let e=this.db.prepare("SELECT * FROM threads WHERE id = ?").get(t);if(!e)throw new u(`No thread ${t}`);return e}getNode(t){let e=this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(t);if(!e)throw new u(`No node ${t}`);return e}blockers(t){return this.db.prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.from_id
         WHERE e.to_id = ? AND e.type = 'blocks' AND n.status NOT IN ('done','abandoned')`).all(t)}children(t){return this.db.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY priority DESC, rowid").all(t)}depth(t){let e=0,n=t.parent_id;for(;n;)e++,n=this.db.prepare("SELECT parent_id FROM nodes WHERE id = ?").get(n).parent_id;return e}createThread(t,e,n=!0,s){return this.tx(()=>{let r=this.nextId("t"),i=this.ts();if(this.db.prepare("INSERT INTO threads (id, title, goal, created_at, touched_at) VALUES (?, ?, ?, ?, ?)").run(r,t,e,i,i),n)for(let o of N(this.cwd))this.addLink(r,o);return this.bindInner(r,s),this.getThread(r)})}addLink(t,e){this.db.prepare("INSERT OR IGNORE INTO links (thread_id, kind, value) VALUES (?, ?, ?)").run(t,e.kind,e.value)}listThreads(t="active"){let e=t==="all"?"SELECT * FROM threads ORDER BY touched_at DESC":"SELECT * FROM threads WHERE status = ? ORDER BY touched_at DESC",n=this.db.prepare(e);return t==="all"?n.all():n.all(t)}threadsForLocation(t){if(!t.length)return[];let e=t.map(()=>"(l.kind = ? AND l.value = ?)").join(" OR ");return this.db.prepare(`SELECT DISTINCT t.* FROM threads t JOIN links l ON l.thread_id = t.id
         WHERE t.status = 'active' AND (${e}) ORDER BY t.touched_at DESC`).all(...t.flatMap(n=>[n.kind,n.value]))}bindInner(t,e){this.bound=t,this.db.prepare(`INSERT INTO sessions (session_id, thread_id, cwd, bound_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET thread_id = excluded.thread_id, cwd = excluded.cwd, bound_at = excluded.bound_at`).run(e??`cwd:${this.cwd}`,t,this.cwd,this.ts()),this.touch(t)}bind(t,e){let n=this.getThread(t);return this.bindInner(n.id,e),n}current(){if(this.bound)return this.getThread(this.bound);let t=this.db.prepare(`SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
         WHERE s.cwd = ? AND t.status = 'active' ORDER BY s.bound_at DESC LIMIT 1`).get(this.cwd);if(t)return this.bound=t.thread_id,this.getThread(t.thread_id);let e=this.threadsForLocation(N(this.cwd));if(e.length===1)return this.bound=e[0].id,e[0];let n=e.length?`Linked threads here: ${e.map(s=>`${s.id} "${s.title}"`).join(", ")}.`:"Use list_threads or thread_create.";throw new u(`No thread bound. Call bind(thread_id). ${n}`)}add(t){let e=this.current();return this.tx(()=>{let n=this.ts(),s=[],r=c=>{let a=/^#(\d+)$/.exec(c);if(a){let E=s[Number(a[1])];if(!E)throw new u(`Reference ${c} must point to an earlier item in this call`);return E}let h=this.getNode(c);if(h.thread_id!==e.id)throw new u(`${c} belongs to thread ${h.thread_id}`);return h.id},i=this.db.prepare(`INSERT INTO nodes (id, thread_id, parent_id, kind, title, body, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),o=this.db.prepare("INSERT OR IGNORE INTO edges (from_id, to_id, type) VALUES (?, ?, 'blocks')"),l=[];for(let c of t){let a=this.nextId("n");s.push(a),i.run(a,e.id,c.parent?r(c.parent):null,c.kind??"task",c.title,c.body??null,c.priority??0,n,n);for(let h of c.blocked_by??[])o.run(r(h),a);for(let h of c.blocks??[])l.push([a,h])}for(let[c,a]of l){let h=r(a);if(h===c)throw new u("A node cannot block itself");o.run(c,h)}return this.touch(e.id),s.map(c=>this.getNode(c))})}start(t){let e=this.getNode(t);if(p.includes(e.status))throw new u(`${t} is ${e.status}; reopen it with update first`);let n=this.blockers(t);if(n.length)throw new u(`${t} is blocked by ${n.map(s=>`${s.id} "${s.title}"`).join(", ")}`);if(e.status==="blocked")throw new u(`${t} is marked blocked; update its status to open first`);return this.tx(()=>{let s=this.ts(),r=this.db.prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active' AND id != ?").all(e.thread_id,t).map(i=>i.id);return this.db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE thread_id = ? AND status = 'active' AND id != ?").run(s,e.thread_id,t),this.db.prepare("UPDATE nodes SET status = 'active', updated_at = ? WHERE id = ?").run(s,t),this.touch(e.thread_id),{node:this.getNode(t),demoted:r}})}done(t,e,n){if(!e?.trim())throw new u("done requires a non-empty summary");let s=this.getNode(t);if(s.status==="done")throw new u(`${t} is already done`);let r=this.children(t).filter(i=>!p.includes(i.status));if(r.length)throw new u(`${t} has unresolved children: ${r.map(i=>i.id).join(", ")}`);return this.tx(()=>{let i=this.ts();this.db.prepare("UPDATE nodes SET status = 'done', summary = ?, refs = ?, updated_at = ? WHERE id = ?").run(e.trim(),n?.length?JSON.stringify(n):null,i,t);let o=this.releaseDependents(t,i);return this.touch(s.thread_id),{node:this.getNode(t),unblocked:o,parentReady:this.parentReady(s.parent_id)}})}releaseDependents(t,e){let n=this.db.prepare(`SELECT n.* FROM edges e JOIN nodes n ON n.id = e.to_id
         WHERE e.from_id = ? AND e.type = 'blocks' AND n.status NOT IN ('done','abandoned')`).all(t),s=[];for(let r of n)this.blockers(r.id).length||(r.status==="blocked"&&this.db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE id = ?").run(e,r.id),s.push(this.getNode(r.id)));return s}parentReady(t){if(!t)return null;let e=this.getNode(t);return p.includes(e.status)?null:this.children(t).every(n=>p.includes(n.status))?e:null}update(t,e){let n=this.getNode(t);if(e.status==="done")throw new u("Use done(id, summary) to complete a node");if(e.status==="abandoned"&&!(e.summary??n.summary)?.trim())throw new u("Abandoning requires a summary explaining why");if(e.status==="active")throw new u("Use start(id) to activate a node");let s=[],r=[];for(let i of["title","body","status","priority","summary","kind"])e[i]!==void 0&&(s.push(`${i} = ?`),r.push(e[i]));if(!s.length)throw new u("No fields to update");return this.tx(()=>{let i=this.ts();this.db.prepare(`UPDATE nodes SET ${s.join(", ")}, updated_at = ? WHERE id = ?`).run(...r,i,t);let o=e.status==="abandoned"?this.releaseDependents(t,i):[];return this.touch(n.thread_id),{node:this.getNode(t),unblocked:o}})}nextOptions(t=3,e){let n=e??this.current().id,s=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status = 'open' AND kind IN ('task','question')").all(n),r=this.now().getTime(),i=[];for(let o of s){if(this.blockers(o.id).length)continue;let l=this.children(o.id).filter(L=>!p.includes(L.status)).length,c=this.depth(o),a=Math.min(7,(r-Date.parse(o.updated_at))/864e5),h=l===0?5:0,E=o.priority*10+h+c*1.5+a*.5,y=[o.priority?`p${o.priority}`:null,l?`${l} open children`:"leaf",c?`depth ${c}`:null,a>=1?`idle ${Math.floor(a)}d`:null].filter(Boolean).join(", ");i.push({node:o,score:Math.round(E*10)/10,why:y})}return i.sort((o,l)=>l.score-o.score||o.node.created_at.localeCompare(l.node.created_at)||o.node.id.localeCompare(l.node.id,void 0,{numeric:!0})),i.slice(0,t)}checkpoint(t){if(!t?.trim())throw new u("checkpoint requires a note");let e=this.current(),s={active:this.db.prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active'").all(e.id).map(i=>i.id),next:this.nextOptions(5,e.id).map(i=>i.node.id)},r=this.db.prepare("INSERT INTO checkpoints (thread_id, note, frontier_json, created_at) VALUES (?, ?, ?, ?)").run(e.id,t.trim(),JSON.stringify(s),this.ts());return this.touch(e.id),{id:Number(r.lastInsertRowid)}}statusText(t){let e=t?this.getThread(t):this.current(),n=Object.fromEntries(this.db.prepare("SELECT status, COUNT(*) AS c FROM nodes WHERE thread_id = ? GROUP BY status").all(e.id).map(a=>[a.status,a.c])),s=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status = 'active'").all(e.id),r=this.db.prepare("SELECT * FROM nodes WHERE thread_id = ? AND status IN ('open','blocked') ORDER BY priority DESC").all(e.id).filter(a=>a.status==="blocked"||this.blockers(a.id).length),i=this.db.prepare("SELECT note, created_at FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT 1").get(e.id),o=[`[autoplan] ${e.id} "${e.title}" (${e.status})`];e.goal&&o.push(`Goal: ${m(e.goal,200)}`);let l=["open","active","blocked","done","abandoned"].filter(a=>n[a]).map(a=>`${n[a]} ${a}`).join(", ");o.push(`Nodes: ${l||"none"}`),s.length&&o.push(`Active: ${s.map(T).join("; ")}`);let c=this.nextOptions(3,e.id);if(c.length){o.push("Next:");for(let a of c)o.push(`  ${T(a.node)}`)}if(r.length){o.push("Blocked:");for(let a of r.slice(0,5)){let h=this.blockers(a.id).map(E=>E.id);o.push(`  ${T(a)}${h.length?` \u2190 ${h.join(", ")}`:""}`)}r.length>5&&o.push(`  \u2026${r.length-5} more`)}return i&&o.push(`Last checkpoint (${i.created_at.slice(0,16)}): ${m(i.note,400)}`),o.join(`
`)}getText(t,e=0){let n=this.getNode(t),s=[`${n.id} [${n.kind}/${n.status}${n.priority?` p${n.priority}`:""}] ${n.title}`,`thread ${n.thread_id}${n.parent_id?`, parent ${n.parent_id}`:""}, updated ${n.updated_at.slice(0,16)}`];n.body&&s.push(`Body: ${n.body}`),n.summary&&s.push(`Summary: ${n.summary}`),n.refs&&s.push(`Refs: ${JSON.parse(n.refs).join(", ")}`);let r=this.blockers(t);r.length&&s.push(`Blocked by: ${r.map(T).join("; ")}`);let i=this.db.prepare("SELECT to_id FROM edges WHERE from_id = ? AND type = 'blocks'").all(t);i.length&&s.push(`Blocks: ${i.map(l=>l.to_id).join(", ")}`);let o=(l,c,a)=>{for(let h of this.children(l))s.push(`${a}${T(h)}${h.summary?` \u2014 ${m(h.summary,120)}`:""}`),c>1&&o(h.id,c-1,a+"  ")};if(e>0)s.push("Children:"),o(t,e,"  ");else{let l=this.children(t).length;l&&s.push(`${l} children (use depth>0 to list)`)}return s.join(`
`)}resume(t){let e=N(this.cwd),n=this.threadsForLocation(e);if(t){let s=this.db.prepare(`SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
           WHERE s.session_id = ? AND t.status = 'active'`).get(t);if(s)return this.bindInner(s.thread_id,t),this.statusText(s.thread_id)}return n.length===1?(this.bindInner(n[0].id,t),this.statusText(n[0].id)):n.length>1?["[autoplan] Multiple active threads are linked to this location. Ask the user which one, then call bind(thread_id):",...n.map(s=>`  ${s.id} "${s.title}" (touched ${s.touched_at.slice(0,10)})`)].join(`
`):""}};function m(d,t){return d.length>t?d.slice(0,t-1)+"\u2026":d}function T(d){return`${d.id} ${d.kind==="task"?"":`(${d.kind}) `}${d.title}`}var v=`usage: autoplan <command> [options]
  resume [--cwd DIR] [--session ID] [--hook]   bind session to thread for DIR and print status
                                               (--hook: read {cwd, session_id} JSON from stdin)
  status [--cwd DIR] [--thread ID]             print status of thread for DIR (or ID)
  threads [--all]                              list threads`;function U(){try{return JSON.parse(C(0,"utf8"))}catch{return{}}}function x(){let{values:d,positionals:t}=$({allowPositionals:!0,options:{cwd:{type:"string"},session:{type:"string"},thread:{type:"string"},hook:{type:"boolean"},all:{type:"boolean"}}}),[e]=t,n=d.cwd,s=d.session;if(d.hook){let i=U();n??=i.cwd,s??=i.session_id}let r=new g(b(),n??process.cwd());switch(e){case"resume":{let i=r.resume(s);return i&&console.log(i),0}case"status":return console.log(r.statusText(d.thread)),0;case"threads":for(let i of r.listThreads(d.all?"all":"active"))console.log(`${i.id} [${i.status}] ${i.title} (touched ${i.touched_at.slice(0,10)})`);return 0;default:return console.error(v),2}}try{process.exitCode=x()}catch(d){if(!(d instanceof u))throw d;console.error(d.message),process.exitCode=1}
