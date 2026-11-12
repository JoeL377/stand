// The model client for the replay scripts: the Anthropic API with a key, or Amazon Bedrock with the
// machine's AWS credentials (STAND_BEDROCK=1, region from AWS_REGION, default us-east-1). Bedrock
// names the same models us.anthropic.<model>, and has no server-side fallback model.
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";

type Body = Record<string, unknown> & { model: string; betas?: string[] };

export function modelClient(apiKey?: string): Anthropic | null {
  if (!process.env.STAND_BEDROCK) return apiKey ? new Anthropic({ apiKey }) : null;
  const bedrock = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION ?? "us-east-1" });
  const onBedrock = ({ fallbacks: _f, ...b }: Body) => ({
    ...b,
    model: b.model.includes(".") ? b.model : `us.anthropic.${b.model}`,
    betas: b.betas?.filter((x) => !x.startsWith("server-side-fallback")),
  });
  const m = bedrock.beta.messages as unknown as Record<"parse" | "create" | "stream", (b: Body, o?: unknown) => unknown>;
  return {
    beta: {
      messages: {
        parse: (b: Body, o?: unknown) => m.parse.call(bedrock.beta.messages, onBedrock(b), o),
        create: (b: Body, o?: unknown) => m.create.call(bedrock.beta.messages, onBedrock(b), o),
        stream: (b: Body, o?: unknown) => m.stream.call(bedrock.beta.messages, onBedrock(b), o),
      },
    },
  } as unknown as Anthropic;
}
