import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {openDb} from "./db.ts";
import {configureAppDefault,initConxtDefault} from "./conxtDefault.ts";
import {ConxtLiveDelivery} from "./conxtLive.ts";
import {ConxtDelivery,type ConxtDestination} from "./conxt.ts";
const d:ConxtDestination={key:"app",label:"Team / Stand",submissionUrl:`https://conxt.test/api/v1/integrations/${randomUUID()}/sources`,token:"test-token"};
function setup(file?:string){
 const db=openDb(file);
 const owner=db.upsertUser({googleSub:null,email:"operator@example.test",name:"Operator",picture:null});
 const existing=db.createRoom("Existing room",owner.id);
 return {db,owner,existing};
}

test("app default connects existing and new rooms once and routes live and final deliveries",async()=>{
 const {db,owner,existing}=setup();
 const prior=db.startMeeting(existing.id);
 configureAppDefault(db.raw,[d],d.key,owner.email);
 assert.equal(db.raw.prepare("SELECT count(*) AS n FROM conxt_meetings WHERE meeting_id=?").get(prior.id)!.n,0);
 const id=db.raw.prepare("SELECT id FROM conxt_connections WHERE room_id=? AND enabled=1").get(existing.id)!.id;
 configureAppDefault(db.raw,[d],d.key,owner.email);
 assert.equal(db.raw.prepare("SELECT id FROM conxt_connections WHERE room_id=? AND enabled=1").get(existing.id)!.id,id);
 const room=db.createRoom("New room",owner.id);
 const m=db.startMeeting(room.id);
 assert.ok(db.raw.prepare("SELECT 1 FROM conxt_meetings WHERE meeting_id=?").get(m.id));
 db.addSegment({meetingId:m.id,itemId:null,speakerId:owner.id,speakerName:owner.name,kind:"speech",text:"Synthetic default-connected transcript.",ts:m.startedAt});
 let live=0,final=0;
 await new ConxtLiveDelivery(db,[d],(async(_url,init)=>{
  live++;const p=JSON.parse(String(init?.body));
  return new Response(JSON.stringify({id:randomUUID(),external_id:p.external_id,sequence:p.sequence,status:"live"}));
 }) as typeof fetch).tick();
 db.endMeeting(m.id,null);
 await new ConxtDelivery(db,[d],(async(_url,init)=>{
  final++;const p=JSON.parse(String(init?.body));
  return new Response(JSON.stringify({receipt:{id:randomUUID(),integration_id:new URL(d.submissionUrl).pathname.split('/')[4],external_id:p.external_id,external_revision:p.external_revision,status:"queued"}}));
 }) as typeof fetch).tick();
 assert.equal(live,1);assert.equal(final,1);db.raw.close();
});

test("opt-out persists across restart and explicit room override survives default changes",()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"stand-default-")),file=path.join(dir,"stand.db");
 let {db,owner,existing}=setup(file);
 configureAppDefault(db.raw,[d],d.key,owner.email);
 db.raw.prepare("INSERT INTO conxt_room_preferences VALUES (?,'off')").run(existing.id);
 db.raw.prepare("UPDATE conxt_connections SET enabled=0 WHERE room_id=?").run(existing.id);
 db.raw.close();db=openDb(file);
 configureAppDefault(db.raw,[d],d.key,owner.email);
 assert.equal(db.raw.prepare("SELECT count(*) AS n FROM conxt_connections WHERE room_id=? AND enabled=1").get(existing.id)!.n,0);
 const custom=db.createRoom("Custom room",owner.id);
 db.raw.prepare("INSERT INTO conxt_room_preferences VALUES (?,'custom')").run(custom.id);
 const old=db.raw.prepare("SELECT id FROM conxt_connections WHERE room_id=? AND enabled=1").get(custom.id)!.id;
 const other={...d,key:"other",submissionUrl:d.submissionUrl.replace('conxt.test','other.test')};
 configureAppDefault(db.raw,[d,other],other.key,owner.email);
 assert.equal(db.raw.prepare("SELECT id FROM conxt_connections WHERE room_id=? AND enabled=1").get(custom.id)!.id,old);
 configureAppDefault(db.raw,[d]);
 assert.equal(db.raw.prepare("SELECT enabled FROM conxt_connections WHERE id=?").get(old)!.enabled,1);
 const unconnected=db.createRoom("Default disabled",owner.id);
 assert.equal(db.raw.prepare("SELECT count(*) AS n FROM conxt_connections WHERE room_id=? AND enabled=1").get(unconnected.id)!.n,0);
 db.raw.close();rmSync(dir,{recursive:true});
});

test("upgrade preserves old room choices and refuses invalid defaults without partial changes",()=>{
 const {db,owner,existing}=setup();
 const id=randomUUID();
 db.raw.prepare("INSERT INTO conxt_connections VALUES (?,?,?,?,?,?,?,0)").run(id,existing.id,d.key,d.submissionUrl,d.label,owner.id,Date.now());
 // Simulate a database from before preference tracking.
 db.raw.exec("DROP TABLE conxt_room_preferences");initConxtDefault(db.raw);
 assert.equal(db.raw.prepare("SELECT mode FROM conxt_room_preferences WHERE room_id=?").get(existing.id)!.mode,"off");
 assert.throws(()=>configureAppDefault(db.raw,[d],"missing",owner.email));
 assert.throws(()=>configureAppDefault(db.raw,[d],d.key,"unknown@example.test"));
 assert.equal(db.raw.prepare("SELECT count(*) AS n FROM conxt_app_default").get()!.n,0);
 configureAppDefault(db.raw,[d],d.key,owner.email);
 assert.equal(db.raw.prepare("SELECT enabled FROM conxt_connections WHERE id=?").get(id)!.enabled,0);
 db.raw.close();
});
