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
  deepgramKey: env("DEEPGRAM_API_KEY"),
  anthropicKey: env("ANTHROPIC_API_KEY"),
  anthropicModel: env("ANTHROPIC_MODEL") ?? "claude-opus-5-5",
  linearKey: env("LINEAR_API_KEY"),
};

export function capabilities(): Capabilities {
  const livekit = Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);
  return {
    livekit,
    // Server-side transcription needs the agent in the LiveKit room to hear people.
    transcription: livekit && config.deepgramKey ? "deepgram" : "browser",
    llm: Boolean(config.anthropicKey),
    linear: Boolean(config.linearKey),
  };
}
