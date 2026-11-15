import {
  instruction,
  parseOrganization,
  type AIProvider,
  type OrganizeInput,
} from "./provider";

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  async organize(input: OrganizeInput) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not configured");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
        max_tokens: 400,
        messages: [{ role: "user", content: instruction(input) }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}`);
    const data = await response.json();
    const text =
      data.content
        ?.filter((part: { type: string }) => part.type === "text")
        .map((part: { text: string }) => part.text)
        .join("") || "null";
    return parseOrganization(
      JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")),
    );
  }
}
