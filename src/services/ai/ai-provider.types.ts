import { z } from "zod";

export type AIAction = "improve" | "expand" | "shorten" | "professional" | "generate";

export type AIContext =
  | "product_description"
  | "post_content"
  | "campaign_email"
  | "event_description"
  | "business_bio"
  | "session_description"
  | "general";

export interface AIMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  /** Set on assistant turns that requested tool calls, so multi-step tool
   *  history can round-trip back through the provider on later turns.
   *  `extra` is an opaque provider payload echoed back verbatim (e.g.
   *  Gemini's required thought_signature). */
  toolCalls?: Array<{ id: string; name: string; args: any; extra?: any }>;
}

export interface AITool<TParams = any, TResult = any> {
  name: string;
  description: string;
  parameters: z.ZodObject<any>;
  execute(params: TParams): Promise<TResult>;
}

export interface AIProviderResponse {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: any;
    /** Opaque provider payload to echo back on later turns. */
    extra?: any;
  }>;
  tokensUsed?: number;
}

export interface AIProvider {
  readonly name: string;
  generateContent(messages: AIMessage[], tools?: AITool[]): Promise<AIProviderResponse>;
  isAvailable(): boolean;
}
