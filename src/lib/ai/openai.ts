import {
  instruction,
  parseOrganization,
  type AIProvider,
  type OrganizeInput,
} from "./provider";

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  async organize(input: OrganizeInput) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not configured");
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        messages: [{ role: "user", content: instruction(input) }],
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
    const data = await response.json();
    return parseOrganization(
      JSON.parse(data.choices?.[0]?.message?.content || "null"),
    );
  }
}
