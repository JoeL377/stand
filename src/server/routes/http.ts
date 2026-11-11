// What every route module uses: errors from async handlers reach the error handler, a plain 404,
// and the check that the signed-in person is in the space a route names.
import type { NextFunction, Request, Response } from "express";
import type { DB } from "../db.ts";

export type Params = Record<string, string>;
type Handler = (req: Request<Params>, res: Response) => unknown;

/** A handler whose thrown errors and rejected promises go to the app's error handler. */
export const route = (fn: Handler) => (req: Request<Params>, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

export const notFound = (res: Response, what = "Not found") => res.status(404).json({ error: what });

/** The space in :id when the signed-in person is in it. Otherwise answers 404 and gives null. */
export function memberRoom(db: DB, req: Request<Params>, res: Response) {
  const room = db.getRoom(req.params.id);
  if (room && db.isMember(room.id, req.user!.id)) return room;
  notFound(res, "Space not found");
  return null;
}
