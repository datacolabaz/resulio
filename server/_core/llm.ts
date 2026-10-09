import { isGeminiUrl, type LlmConfig, openAiEndpoint } from "./aiConfig";
import { ENV } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

/** OpenAI's inline file part (`file_data` is a `data:` URI), e.g. a PDF for vision models. */
export type FileDataContent = {
  type: "file";
  file: {
    filename?: string;
    file_data: string;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent | FileDataContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  model?: string;
  thinking?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  /** Per attempt; defaults to REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /** HTTP-level retries of 5xx/408/429 and network errors; defaults to RETRY_MAX_RETRIES. */
  maxRetries?: number;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent | FileDataContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url" || part.type === "file") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

const requireLlmConfig = (): LlmConfig => {
  const config = ENV.llm;
  if (!config.source) {
    throw new Error("LLM is not configured: set AI_API_KEY (and optionally AI_API_URL), or MANUS_API_URL and MANUS_API_KEY");
  }
  return config;
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

const RETRY_MAX_RETRIES = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;
/** Per attempt; thinking models can take a while on long submissions. */
const REQUEST_TIMEOUT_MS = 60_000;
const ERROR_BODY_MAX_CHARS = 500;

/** A wrong key, model or request body will not start working on a retry; timeouts and 429 may. */
const isRetryableStatus = (status: number) => status >= 500 || status === 408 || status === 429;

/** "minute" = a rate window that reopens soon; "day" = a daily quota, or a model with no quota at all ("limit: 0"). */
export type QuotaWindow = "minute" | "day";

export interface RateLimitHints {
  retryAfterMs?: number;
  quotaWindow?: QuotaWindow;
}

/**
 * What a 429 body says. Gemini sends no Retry-After header: the wait is in google.rpc.RetryInfo
 * ("retryDelay": "41s") or the message ("Please retry in 41.2s"), the window in the QuotaFailure id
 * ("GenerateRequestsPerMinutePerProjectPerModel-FreeTier").
 */
export function rateLimitHints(body: string): RateLimitHints {
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body) ?? /retry in (\d+(?:\.\d+)?)\s*s\b/i.exec(body);
  const retryAfterMs = delay ? Math.ceil(Number(delay[1]) * 1000) : undefined;
  const quotaWindow: QuotaWindow | undefined = /PerDay|limit:\s*0(?!\d)|insufficient_quota/i.test(body) ? "day" : /PerMinute/i.test(body) ? "minute" : undefined;
  return { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(quotaWindow ? { quotaWindow } : {}) };
}

/** Non-2xx reply from the provider; `status` lets callers tell a bad key (401/403) from quota (429). */
export class LlmHttpError extends Error {
  public readonly retryAfterMs?: number;
  public readonly quotaWindow?: QuotaWindow;
  constructor(public readonly status: number, message: string, hints: RateLimitHints = {}) {
    super(message);
    this.name = "LlmHttpError";
    this.retryAfterMs = hints.retryAfterMs;
    this.quotaWindow = hints.quotaWindow;
  }
}

export type LlmFailureReason = "AI_KEY_INVALID" | "AI_NOT_FOUND" | "AI_QUOTA" | "AI_REQUEST_FAILED";

/** Gemini answers a bad key with 400 "API key not valid", not 401/403. */
export function llmFailureReason(error: unknown): LlmFailureReason {
  if (!(error instanceof LlmHttpError)) return "AI_REQUEST_FAILED";
  const { status, message } = error;
  if (status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(message))) return "AI_KEY_INVALID";
  if (status === 404 || (status === 400 && /models\/\S+ is not found/i.test(message))) return "AI_NOT_FOUND";
  if (status === 429) return "AI_QUOTA";
  return "AI_REQUEST_FAILED";
}

/** A JSON error body ({error:{status,message}}, or Gemini's [{error:…}]) as "STATUS [quota id] message"; other bodies as is. */
function summarizeErrorBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const first = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { status?: unknown; message?: unknown } } | null;
    const error = first?.error;
    if (error && typeof error.message === "string") {
      const quotaId = /"quotaId"\s*:\s*"([^"]+)"/.exec(body)?.[1];
      return `${typeof error.status === "string" ? `${error.status} ` : ""}${quotaId ? `[quota ${quotaId}] ` : ""}${error.message}`;
    }
  } catch {
    // Not JSON.
  }
  return body;
}

const providerError = async (response: Response, what: string, model: string, url: string) => {
  const raw = await response.text().catch(() => "");
  const hints = rateLimitHints(raw);
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after")) ?? hints.retryAfterMs;
  const body = summarizeErrorBody(raw).replace(/\s+/g, " ").trim().slice(0, ERROR_BODY_MAX_CHARS);
  return new LlmHttpError(
    response.status,
    `${what} failed: ${response.status} ${response.statusText} (model ${model || "default"}, ${new URL(url).host}) – ${body}`,
    { ...hints, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  );
};

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
};

// Equal-jitter exponential backoff. The cap/2 floor guarantees a minimum
// delay so a misbehaving caller loop slows down instead of hammering the
// upstream while it keeps returning errors.
const computeBackoffDelay = (
  attempt: number,
  retryAfterMs?: number
): number => {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  const jittered = cap / 2 + Math.random() * (cap / 2);
  return Math.min(Math.max(jittered, retryAfterMs ?? 0), RETRY_MAX_DELAY_MS);
};

// Retries 5xx/408/429 responses and network errors with exponential backoff, then
// returns the final Response so callers keep their existing error handling. A 429 for a
// daily quota is returned at once: no retry today can succeed.
const fetchWithBackoff = async (
  url: string,
  init: FetchInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxRetries = RETRY_MAX_RETRIES
): Promise<Response> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      // A request that timed out once will most likely time out again (and may still be billed).
      if (attempt === maxRetries || (error instanceof Error && error.name === "TimeoutError")) throw error;
      console.warn(
        `LLM request retry ${attempt + 1}/${maxRetries} after network error`
      );
      await sleep(computeBackoffDelay(attempt));
      continue;
    }
    if (response.ok || !isRetryableStatus(response.status)) return response;

    let retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (response.status === 429) {
      const text = await response.text().catch(() => "");
      const hints = rateLimitHints(text);
      if (attempt === maxRetries || hints.quotaWindow === "day") {
        return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      retryAfterMs ??= hints.retryAfterMs;
    } else {
      if (attempt === maxRetries) return response;
      try {
        await response.body?.cancel();
      } catch {
        // Body already settled; nothing to clean up.
      }
    }
    console.warn(
      `LLM request retry ${attempt + 1}/${maxRetries} after status ${response.status}`
    );
    await sleep(computeBackoffDelay(attempt, retryAfterMs));
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("LLM request failed after exhausting retries");
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const config = requireLlmConfig();

  const {
    messages,
    tools,
    toolChoice,
    tool_choice,
    outputSchema,
    output_schema,
    responseFormat,
    response_format,
    model,
    thinking,
    reasoning,
    maxTokens,
    max_tokens,
    timeoutMs,
    maxRetries,
  } = params;

  const payload: Record<string, unknown> = {
    messages: messages.map(normalizeMessage),
  };

  const resolvedModel = model || config.model;
  if (resolvedModel) {
    payload.model = resolvedModel;
  }

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const normalizedToolChoice = normalizeToolChoice(
    toolChoice || tool_choice,
    tools
  );
  if (normalizedToolChoice) {
    payload.tool_choice = normalizedToolChoice;
  }

  const resolvedMaxTokens = max_tokens ?? maxTokens;
  if (typeof resolvedMaxTokens === "number") {
    payload.max_tokens = resolvedMaxTokens;
  }

  if (thinking) {
    payload.thinking = thinking;
  }
  if (reasoning) {
    payload.reasoning = reasoning;
  }
  // Gemini 3 models always think and the thinking tokens count against max_tokens; "low" keeps
  // short JSON answers from being cut off. Other providers may reject the field.
  if (isGeminiUrl(config.baseUrl)) {
    payload.reasoning_effort = "low";
  }

  const normalizedResponseFormat = normalizeResponseFormat({
    responseFormat,
    response_format,
    outputSchema,
    output_schema,
  });

  if (normalizedResponseFormat) {
    payload.response_format = normalizedResponseFormat;
  }

  const url = openAiEndpoint(config.baseUrl, "chat/completions");
  const response = await fetchWithBackoff(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  }, timeoutMs, maxRetries);

  if (!response.ok) {
    throw await providerError(response, "LLM invoke", resolvedModel, url);
  }

  return (await response.json()) as InvokeResult;
}

export type ModelInfo = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type ModelsResponse = {
  object: string;
  data: ModelInfo[];
};

export async function listLLMModels(): Promise<ModelsResponse> {
  const config = requireLlmConfig();

  const url = openAiEndpoint(config.baseUrl, "models");
  const response = await fetchWithBackoff(url, {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });

  if (!response.ok) {
    throw await providerError(response, "List LLM models", config.model, url);
  }

  return (await response.json()) as ModelsResponse;
}
