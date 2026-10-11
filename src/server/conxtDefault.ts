import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { ConxtDestination } from "./conxt.ts";

export function initConxtDefault(sql: DatabaseSync) {
  const fresh=!sql.prepare("SELECT 1 FROM sqlite_master WHERE name='conxt_room_preferences'").get();
  sql.exec(`
    CREATE TABLE IF NOT EXISTS conxt_room_preferences (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id), mode TEXT NOT NULL CHECK(mode IN ('inherit','custom','off'))
    );
    CREATE TABLE IF NOT EXISTS conxt_app_default (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), destination_key TEXT NOT NULL,
      submission_url TEXT NOT NULL, label TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS conxt_default_connections (
      connection_id TEXT PRIMARY KEY REFERENCES conxt_connections(id)
    );
    CREATE TRIGGER IF NOT EXISTS conxt_default_new_room AFTER INSERT ON rooms BEGIN
      INSERT INTO conxt_connections(id,room_id,destination_key,submission_url,label,connected_by,connected_at,enabled)
      SELECT lower(hex(randomblob(16))),NEW.id,destination_key,submission_url,label,actor_id,
             CAST(unixepoch('subsec')*1000 AS INTEGER),1 FROM conxt_app_default;
      INSERT INTO conxt_default_connections(connection_id)
      SELECT id FROM conxt_connections WHERE room_id=NEW.id AND enabled=1;
    END;
  `);
  if(fresh) {
    // Preserve explicit existing connections and past disconnects on upgrade.
    sql.exec(`INSERT INTO conxt_room_preferences(room_id,mode)
      SELECT room_id,CASE WHEN max(enabled)=1 THEN 'custom' ELSE 'off' END
      FROM conxt_connections GROUP BY room_id;`);
  }
}

export function inheritAppDefault(sql: DatabaseSync, roomId: string): boolean {
  const d=sql.prepare("SELECT * FROM conxt_app_default WHERE singleton=1").get();
  if(!d)return false;
  const mode=sql.prepare("SELECT mode FROM conxt_room_preferences WHERE room_id=?").get(roomId)?.mode;
  if(mode==='off'||mode==='custom')return false;
  const active=sql.prepare(`SELECT c.* FROM conxt_connections c JOIN conxt_default_connections d ON d.connection_id=c.id
    WHERE c.room_id=? AND c.enabled=1`).get(roomId);
  if(!active && sql.prepare("SELECT 1 FROM conxt_connections WHERE room_id=? AND enabled=1").get(roomId)) {
    sql.prepare("INSERT INTO conxt_room_preferences VALUES (?,'custom') ON CONFLICT(room_id) DO UPDATE SET mode='custom'").run(roomId);
    return false;
  }
  if(active?.destination_key===d.destination_key&&active?.submission_url===d.submission_url)return true;
  sql.prepare("UPDATE conxt_connections SET enabled=0 WHERE room_id=?").run(roomId);
  const id=randomUUID();
  sql.prepare("INSERT INTO conxt_connections VALUES (?,?,?,?,?,?,?,1)")
    .run(id,roomId,d.destination_key,d.submission_url,d.label,d.actor_id,Date.now());
  sql.prepare("INSERT INTO conxt_default_connections VALUES (?)").run(id);
  return true;
}

export function configureAppDefault(sql: DatabaseSync, destinations: ConxtDestination[], key?: string, operatorEmail?: string) {
  const d=key?destinations.find(d=>d.key===key):undefined;
  if(key&&!d)throw new Error("CONXT_DEFAULT_DESTINATION must select a configured Conxt destination");
  const actor=d&&operatorEmail?sql.prepare("SELECT id FROM users WHERE lower(email)=lower(?)").get(operatorEmail):undefined;
  if(d&&!actor)throw new Error("CONXT_DEFAULT_OPERATOR_EMAIL must identify an existing Stand operator");
  sql.exec("BEGIN IMMEDIATE");
  try {
    if(d) {
      sql.prepare(`INSERT INTO conxt_app_default VALUES (1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
        destination_key=excluded.destination_key,submission_url=excluded.submission_url,label=excluded.label,actor_id=excluded.actor_id`)
        .run(d.key,d.submissionUrl,d.label,actor!.id);
      for(const r of sql.prepare("SELECT id FROM rooms").all())inheritAppDefault(sql,String(r.id));
    } else {
      sql.exec(`DELETE FROM conxt_app_default;
        UPDATE conxt_connections SET enabled=0 WHERE id IN (SELECT connection_id FROM conxt_default_connections)
        AND room_id NOT IN (SELECT room_id FROM conxt_room_preferences WHERE mode='custom');`);
    }
    sql.exec("COMMIT");
  }catch(e){sql.exec("ROLLBACK");throw e;}
}
