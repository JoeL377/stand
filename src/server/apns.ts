// Apple's push service (APNs): one notification to one iPhone, over HTTP/2, signed with the team's
// .p8 key (a JWT that lives under an hour). No library: node's http2 and crypto are enough.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import type { ApnsEnv, PushMessage } from "../shared/push.ts";

const HOSTS: Record<ApnsEnv, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};
/** Apple wants a new token at most every hour and at least every 20 minutes' use apart; 40 minutes sits between. */
const TOKEN_MS = 40 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

export interface ApnsKey {
  key: string;
  keyId: string;
  teamId: string;
  /** The app's bundle id. */
  topic: string;
}

/** Thrown for a token Apple says is no longer a phone's (the app was deleted, or notifications went off). */
export class DeviceGone extends Error {}

export class Apns {
  private readonly key: KeyObject;
  private jwt: { value: string; at: number } | null = null;
  private readonly sessions = new Map<ApnsEnv, http2.ClientHttp2Session>();

  constructor(private readonly cfg: ApnsKey) {
    this.key = createPrivateKey(cfg.key);
  }

  private token() {
    if (this.jwt && Date.now() - this.jwt.at < TOKEN_MS) return this.jwt.value;
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = `${enc({ alg: "ES256", kid: this.cfg.keyId })}.${enc({ iss: this.cfg.teamId, iat: Math.floor(Date.now() / 1000) })}`;
    const sig = sign("sha256", Buffer.from(head), { key: this.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { value: `${head}.${sig}`, at: Date.now() };
    return this.jwt.value;
  }

  private session(env: ApnsEnv) {
    const was = this.sessions.get(env);
    if (was && !was.closed && !was.destroyed) return was;
    const s = http2.connect(HOSTS[env]);
    s.on("error", () => this.sessions.delete(env));
    s.on("close", () => this.sessions.delete(env));
    s.unref();
    this.sessions.set(env, s);
    return s;
  }

  send(device: { token: string; env: ApnsEnv }, m: PushMessage): Promise<void> {
    const body = JSON.stringify({
      aps: { alert: { title: m.title, body: m.body }, sound: "default", "thread-id": m.tag },
      url: m.url,
    });
    return new Promise((resolve, reject) => {
      const req = this.session(device.env).request({
        ":method": "POST",
        ":path": `/3/device/${device.token}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": this.cfg.topic,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + 24 * 3600),
        // A newer notification for the same chat replaces the one still on the lock screen.
        "apns-collapse-id": m.tag.slice(0, 64),
        "content-type": "application/json",
      });
      req.setTimeout(SEND_TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL));
      let status = 0;
      let text = "";
      req.on("response", (h) => (status = Number(h[":status"])));
      req.setEncoding("utf8");
      req.on("data", (d: string) => (text += d));
      req.on("error", reject);
      req.on("close", () => {
        if (status === 200) return resolve();
        let reason = "";
        try {
          reason = (JSON.parse(text) as { reason?: string }).reason ?? "";
        } catch {}
        if (status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") return reject(new DeviceGone(reason || String(status)));
        reject(new Error(`APNs ${status || "no answer"} ${reason}`.trim()));
      });
      req.end(body);
    });
  }

  close() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
