import path from "node:path";
import type { Capabilities } from "../shared/protocol.ts";

const env = (k: string) => process.env[k]?.trim() || undefined;

export const config = {
  port: Number(env("PORT") ?? 3001),
  dataDir: path.resolve(env("DATA_DIR") ?? "./data"),
  production: process.env.NODE_ENV === "production",
  livekit: {
    url: env("LIVEKIT_URL"),
    apiKey: env("LIVEKIT_API_KEY"),
    apiSecret: env("LIVEKIT_API_SECRET"),
  },
  /** Optional: talk to Deepgram directly instead of through LiveKit Inference. */
  deepgramKey: env("DEEPGRAM_API_KEY"),
  /** LiveKit Inference speech-to-text model. */
  sttModel: env("STT_MODEL") ?? "deepgram/nova-3",
  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL") ?? "claude-opus-5-5",
  linearKey: env("LINEAR_API_KEY"),
  google: {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
  },
  /** Public origin, e.g. https://standup.example.com. Defaults to the request's own origin. */
  publicUrl: env("PUBLIC_URL"),
  /** Comma-separated email domains allowed to sign in, e.g. "acme.com". Empty = anyone. */
  allowedDomains: (env("ALLOWED_EMAIL_DOMAINS") ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean),
};

/** Without Google credentials, people sign in with just a name and email
 *  (no verification) so the app can be tried before OAuth is set up. */
export const googleEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);

export function capabilities(): Capabilities {
  const livekit = Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);
  return {
    livekit,
    // Server-side transcription needs the agent in the LiveKit room to hear people.
    // LiveKit Inference bills speech-to-text to the LiveKit account, so no extra key.
    transcription: !livekit ? "browser" : config.deepgramKey ? "deepgram" : "livekit",
    llm: Boolean(config.anthropicKey),
    linear: Boolean(config.linearKey),
    googleSignIn: googleEnabled(),
  };
}
