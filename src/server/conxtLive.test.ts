import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "./db.ts";
import { ConxtLiveDelivery } from "./conxtLive.ts";
import type { ConxtDestination } from "./conxt.ts";
const destination:ConxtDestination={key:"team",label:"Team",token:"test-token",submissionUrl:`https://conxt.test/api/v1/integrations/${randomUUID()}/sources`};
function setup(file?:string){
 const db=openDb(file);
 const owner=db.upsertUser({googleSub:null,email:"test@example.test",name:"Alice",picture:null});
 const room=db.createRoom("Live planning",owner.id);
 const connection=randomUUID();
 db.raw.prepare("INSERT INTO conxt_connections VALUES (?,?,?,?,?,?,?,1)").run(connection,room.id,destination.key,destination.submissionUrl,destination.label,owner.id,Date.now());
 const meeting=db.startMeeting(room.id);
 return {db,meeting,room,connection};
}
function due(db:ReturnType<typeof openDb>){db.raw.prepare("UPDATE conxt_live_deliveries SET next_at=0").run();}
function response(payload:any,id:string){return new Response(JSON.stringify({id,external_id:payload.external_id,sequence:payload.sequence,status:payload.ended?"ended":"live"}),{status:200});}

test("live turns extend without duplicates, survive lost acknowledgments and restart, and close separately from final source",async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),"stand-live-"));
 const file=path.join(dir,"stand.db");
 let {db,meeting,connection}=setup(file);
 const segment=db.addSegment({meetingId:meeting.id,itemId:null,speakerId:"a",speakerName:"Alice",kind:"speech",text:"We should",ts:meeting.startedAt});
 let first="";const stream=randomUUID();
 await new ConxtLiveDelivery(db,[destination],(async(_url,init)=>{first=String(init?.body);throw new Error("accepted but ack lost");}) as typeof fetch).tick();
 db.raw.close();db=openDb(file);due(db);
 let worker=new ConxtLiveDelivery(db,[destination],(async(url,init)=>{
  assert.match(String(url),/\/live-transcripts$/);assert.equal(init?.body,first);
  return response(JSON.parse(first),stream);
 }) as typeof fetch);
 await worker.tick();
 db.appendSegmentText(segment.id,"use PostgreSQL.");due(db);
 worker=new ConxtLiveDelivery(db,[destination],(async(_url,init)=>{
  const p=JSON.parse(String(init?.body));assert.equal(p.sequence,2);
  assert.equal(p.turns.length,1);assert.equal(p.turns[0].id,segment.id);
  assert.equal(p.turns[0].text,"We should use PostgreSQL.");return response(p,stream);
 }) as typeof fetch);
 await worker.tick();
 db.endMeeting(meeting.id,"Summary");due(db);
 worker=new ConxtLiveDelivery(db,[destination],(async(_url,init)=>{
  const p=JSON.parse(String(init?.body));assert.equal(p.sequence,3);assert.equal(p.ended,true);assert.deepEqual(p.turns,[]);
  const final=JSON.parse(db.raw.prepare("SELECT payload FROM conxt_deliveries WHERE meeting_id=?").get(meeting.id)!.payload as string);
  assert.equal(p.external_id,final.external_id);return response(p,stream);
 }) as typeof fetch);
 await worker.tick();
 assert.equal(db.raw.prepare("SELECT state FROM conxt_live_deliveries WHERE meeting_id=?").get(meeting.id)!.state,"ended");
 db.raw.close();rmSync(dir,{recursive:true});
});

test("disconnection stops live sharing and changed destination never reroutes a pending batch",async()=>{
 const {db,meeting,connection}=setup();
 db.addSegment({meetingId:meeting.id,itemId:null,speakerId:"a",speakerName:"Alice",kind:"chat",text:"Hello",ts:meeting.startedAt});
 let calls=0;
 const send=(async(_url,init)=>{calls++;return response(JSON.parse(String(init?.body)),randomUUID());}) as typeof fetch;
 await new ConxtLiveDelivery(db,[{...destination,submissionUrl:destination.submissionUrl.replace('conxt.test','other.test')}],send).tick();
 assert.equal(calls,0);
 assert.equal(db.raw.prepare("SELECT state FROM conxt_live_deliveries").get()!.state,"failed");
 db.raw.prepare("UPDATE conxt_live_deliveries SET state='queued',next_at=0").run();
 db.raw.prepare("UPDATE conxt_connections SET enabled=0 WHERE id=?").run(connection);
 db.appendSegmentText(db.meetingSegments(meeting.id)[0].id,"Private continuation");
 await new ConxtLiveDelivery(db,[destination],send).tick();assert.equal(calls,0);
 assert.equal(db.raw.prepare("SELECT count(*) AS n FROM conxt_live_events").get()!.n,1);
 db.raw.close();
});

test("ended meeting with more than one batch closes only after the last turn",async()=>{
 const {db,meeting}=setup();
 for(let i=0;i<101;i++)db.addSegment({meetingId:meeting.id,itemId:null,speakerId:"a",speakerName:"Alice",kind:"chat",text:`Turn ${i}`,ts:meeting.startedAt+i});
 db.endMeeting(meeting.id,null);const stream=randomUUID();const batches:any[]=[];
 const worker=new ConxtLiveDelivery(db,[destination],(async(_url,init)=>{
  const p=JSON.parse(String(init?.body));batches.push(p);return response(p,stream);
 }) as typeof fetch);
 await worker.tick();due(db);await worker.tick();
 assert.equal(batches[0].turns.length,100);assert.equal(batches[0].ended,false);
 assert.equal(batches[1].turns.length,1);assert.equal(batches[1].ended,true);
 db.raw.close();
});
