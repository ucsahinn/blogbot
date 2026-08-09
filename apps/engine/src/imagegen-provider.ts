export interface ImageGenerationRequest {
  title: string;
  articleType: string;
  section: string;
  sourceTitles: string[];
  /** Article-owned editorial context, never raw source bodies. */
  summary?: string;
  /** Small, bounded factual anchors that define the visual subject. */
  keyClaims?: string[];
  /** Explicit visual direction authored for this article. */
  visualIntent?: string;
}

export interface ImageGeneratorPort {
  generate(request: ImageGenerationRequest): Promise<Uint8Array>;
}

export interface OpenAiImageGeneratorOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

function boundedPromptText(value: unknown, maximum: number): string {
  return typeof value === "string"
    ? value.replaceAll("\u0000", "").replace(/\s+/gu, " ").trim().slice(0, maximum)
    : "";
}

function promptFor(request: ImageGenerationRequest): string {
  const context = request.sourceTitles.filter(Boolean).slice(0, 3).join("; ");
  const summary = boundedPromptText(request.summary, 900);
  const claims = Array.isArray(request.keyClaims)
    ? request.keyClaims.map((claim) => boundedPromptText(claim, 280)).filter(Boolean).slice(0, 4)
    : [];
  const visualIntent = boundedPromptText(request.visualIntent, 600);
  return [
    "Create an original editorial hero image for a Turkish publication.",
    `Article title: ${request.title.slice(0, 240)}`,
    `Article type: ${request.articleType.slice(0, 80)}. Section: ${request.section.slice(0, 80)}.`,
    context ? `Verified context only: ${context.slice(0, 600)}.` : "Use the title as the only context.",
    summary ? `Editorial summary: ${summary}` : "",
    claims.length > 0 ? `Key factual anchors: ${claims.join(" | ")}` : "",
    visualIntent ? `Required visual direction: ${visualIntent}` : "",
    "Use a polished documentary-editorial visual language, with a clear main subject and room for an article headline overlay.",
    "Do not include readable text, logos, watermarks, public figures, brand marks, screenshots, or copied artwork."
  ].filter(Boolean).join("\n");
}

/**
 * Thin runtime adapter for ImageGen. The API key is read only from the parent
 * process environment by the packaged host and is never persisted in PGlite,
 * diagnostics, task prompts, or desktop settings.
 */
export function createOpenAiImageGenerator(options: OpenAiImageGeneratorOptions): ImageGeneratorPort {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("IMAGEGEN_API_KEY_REQUIRED");
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model?.trim() || "gpt-image-1";
  return {
    async generate(request) {
      const response = await fetchImpl("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          prompt: promptFor(request),
          size: "1536x1024",
          quality: "medium",
          n: 1
        }),
        signal: AbortSignal.timeout(90_000)
      });
      if (!response.ok) throw new Error(`IMAGEGEN_HTTP_${response.status}`);
      const payload = await response.json() as { data?: Array<{ b64_json?: unknown }> };
      const encoded = payload.data?.[0]?.b64_json;
      if (typeof encoded !== "string" || !encoded.trim()) throw new Error("IMAGEGEN_RESPONSE_INVALID");
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > 20_000_000) throw new Error("IMAGEGEN_RESPONSE_INVALID");
      return bytes;
    }
  };
}

export function imageGeneratorFromEnvironment(environment: NodeJS.ProcessEnv = process.env): ImageGeneratorPort | undefined {
  const apiKey = environment.BLOGBOT_IMAGEGEN_API_KEY;
  if (!apiKey?.trim()) return undefined;
  const model = environment.BLOGBOT_IMAGEGEN_MODEL?.trim();
  return createOpenAiImageGenerator({ apiKey, ...(model ? { model } : {}) });
}
