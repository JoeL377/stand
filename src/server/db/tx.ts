import type { DatabaseSync } from "node:sqlite";

/** Runs fn as one unit: all of its writes land, or none do. Nests, so a caller can hold its own. */
export type Tx = <T>(fn: () => T) => T;

export function transactions(db: DatabaseSync): Tx {
  let depth = 0;
  return <T>(fn: () => T): T => {
    const sp = `tx${++depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${sp}`);
      return out;
    } catch (e) {
      db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    } finally {
      depth--;
    }
  };
}
