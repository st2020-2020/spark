import { RulesProvider } from "./rules";
import { OpenAIProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import type { AIProvider, OrganizeInput } from "./provider";

export function getProvider(): AIProvider {
  switch (process.env.AI_PROVIDER) {
    case "openai":
      return new OpenAIProvider();
    case "anthropic":
      return new AnthropicProvider();
    default:
      return new RulesProvider();
  }
}

export async function organize(input: OrganizeInput) {
  const provider = getProvider();
  try {
    return {
      ...(await provider.organize(input)),
      provider: provider.name,
      status: "ready" as const,
    };
  } catch {
    // Never log provider responses or keys; the original entry remains saved.
    return {
      ...(await new RulesProvider().organize(input)),
      provider: "rules",
      status: "fallback" as const,
    };
  }
}
