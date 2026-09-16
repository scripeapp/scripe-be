/**
 * AI Service
 * Provides AI-powered text enhancement using Gemini API
 */

import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";

// AI Enhancement Action Types
export type AIAction = "improve" | "expand" | "shorten" | "professional" | "generate";

// Context Types for Tailored Prompts
export type AIContext =
  | "product_description"
  | "post_content"
  | "campaign_email"
  | "event_description"
  | "business_bio"
  | "session_description"
  | "general";

// Request/Response Types
export interface EnhanceTextRequest {
  text: string;
  action: AIAction;
  context: AIContext;
  additionalInstructions?: string;
}

export interface GenerateTextRequest {
  prompt: string;
  context: AIContext;
  maxLength?: number;
}

export interface AIResponse {
  success: boolean;
  text?: string;
  error?: string;
  tokensUsed?: number;
}

// Prompt Templates by Context
const CONTEXT_PROMPTS: Record<AIContext, string> = {
  product_description: `You are a skilled e-commerce copywriter. Your task is to write compelling product descriptions that:
- Highlight key features and benefits
- Use persuasive language that drives purchases
- Keep a professional yet engaging tone
- Include relevant details shoppers need`,

  post_content: `You are a social media content creator. Your task is to write engaging posts that:
- Capture attention quickly
- Use a conversational, authentic voice
- Encourage engagement and sharing
- Are appropriate for a knowledge-sharing platform`,

  campaign_email: `You are an email marketing expert. Your task is to write email content that:
- Has a clear, compelling subject line when asked
- Uses a warm, professional tone
- Drives the desired action (click, purchase, register)
- Is concise and scannable`,

  event_description: `You are an event marketing specialist. Your task is to write event descriptions that:
- Clearly communicate what, when, where
- Highlight what attendees will gain
- Create excitement and urgency
- Include all essential details`,

  business_bio: `You are a brand strategist. Your task is to write business descriptions that:
- Clearly communicate the value proposition
- Build trust and credibility
- Differentiate from competitors
- Use professional, authentic language`,

  session_description: `You are an educational content creator. Your task is to write session/course descriptions that:
- Clearly explain what participants will learn
- Highlight the instructor's expertise
- Create value proposition for attending
- Use clear, accessible language`,

  general: `You are a skilled writer. Your task is to improve text by:
- Enhancing clarity and readability
- Fixing grammar and style issues
- Making the content more engaging
- Maintaining the original intent`,
};

// Action Instructions
const ACTION_INSTRUCTIONS: Record<AIAction, string> = {
  improve: `Improve this text by enhancing clarity, fixing any issues, and making it more engaging while keeping the same length and meaning.`,
  expand: `Expand this text with more details, examples, and supporting information. Make it approximately 50% longer while maintaining quality.`,
  shorten: `Condense this text to be more concise while keeping all key information. Aim for about 50% shorter.`,
  professional: `Rewrite this text in a more professional, polished tone suitable for business communication.`,
  generate: `Generate content based on the following prompt. Be creative but stay on topic.`,
};

const DEFAULT_MODELS = [
  process.env.GEMINI_AI_MODEL || "gemini-flash-latest",
  "gemini-2.5-flash",
  "gemini-3-flash-preview",
  "gemini-2.0-flash-lite",
];

class AIService {
  private client: GoogleGenerativeAI | null = null;
  private initialized = false;
  private currentModelName: string = DEFAULT_MODELS[0];

  constructor() {
    this.initialize();
  }

  private initialize(): void {
    const apiKey = process.env.GEMINI_AI_API_KEY;
    
    if (!apiKey) {
      console.warn("[AIService] GEMINI_AI_API_KEY not configured - AI features disabled");
      return;
    }

    try {
      this.client = new GoogleGenerativeAI(apiKey);
      this.initialized = true;
      console.log(`[AIService] Initialized (Primary model: ${this.currentModelName})`);
    } catch (error) {
      console.error("[AIService] Failed to initialize:", error);
    }
  }

  /**
   * Check if AI service is available
   */
  isAvailable(): boolean {
    return this.initialized && this.client !== null;
  }

  /**
   * Internal helper to execute with fallback
   */
  private async executeWithFallback(
    fn: (model: GenerativeModel) => Promise<any>
  ): Promise<any> {
    if (!this.client) throw new Error("AI client not initialized");

    let lastError: any = null;
    
    // Try each model in the list until one succeeds
    for (const modelName of DEFAULT_MODELS) {
      try {
        const model = this.client.getGenerativeModel({ model: modelName });
        const result = await fn(model);
        
        // If we switched to a different model, update the "current" one for future calls
        if (this.currentModelName !== modelName) {
          console.log(`[AIService] Switched to fallback model: ${modelName}`);
          this.currentModelName = modelName;
        }
        
        return result;
      } catch (error: any) {
        lastError = error;
        const statusCode = error?.status || error?.response?.status;
        const isQuotaError = statusCode === 429 || error.message?.includes("429") || error.message?.includes("quota");
        const isNotFoundError = statusCode === 404 || error.message?.includes("404") || error.message?.includes("not found");

        if (isQuotaError || isNotFoundError) {
          console.warn(`[AIService] Model ${modelName} failed (${isQuotaError ? "Quota" : "Not Found"}). Trying next fallback...`);
          continue; // Try next model
        }
        
        // If it's a different error, we might want to throw immediately, 
        // but for robustness let's try at least one more if available.
        console.error(`[AIService] Model ${modelName} failed:`, error.message);
      }
    }

    throw lastError;
  }

  /**
   * Enhance existing text with AI
   */
  async enhanceText(request: EnhanceTextRequest): Promise<AIResponse> {
    if (!this.isAvailable()) {
      return { success: false, error: "AI service not available" };
    }

    const { text, action, context, additionalInstructions } = request;

    // Validate input
    if (!text || text.trim().length === 0) {
      return { success: false, error: "Text is required" };
    }

    if (text.length > 10000) {
      return { success: false, error: "Text too long (max 10000 characters)" };
    }

    try {
      const contextPrompt = CONTEXT_PROMPTS[context] || CONTEXT_PROMPTS.general;
      const actionInstruction = ACTION_INSTRUCTIONS[action];

      const fullPrompt = `${contextPrompt}

${actionInstruction}

${additionalInstructions ? `Additional instructions: ${additionalInstructions}\n\n` : ""}Original text:
"""
${text}
"""

Provide ONLY the improved text, no explanations or metadata.`;

      const result = await this.executeWithFallback((model) => model.generateContent(fullPrompt));
      const response = result.response;
      const generatedText = response.text();

      return {
        success: true,
        text: generatedText.trim(),
        tokensUsed: response.usageMetadata?.totalTokenCount,
      };
    } catch (error: any) {
      console.error("[AIService] Enhancement failed:", error);
      return {
        success: false,
        error: error.message || "Failed to enhance text",
      };
    }
  }

  /**
   * Generate new text from a prompt
   */
  async generateText(request: GenerateTextRequest): Promise<AIResponse> {
    if (!this.isAvailable()) {
      return { success: false, error: "AI service not available" };
    }

    const { prompt, context, maxLength } = request;

    // Validate input
    if (!prompt || prompt.trim().length === 0) {
      return { success: false, error: "Prompt is required" };
    }

    if (prompt.length > 2000) {
      return { success: false, error: "Prompt too long (max 2000 characters)" };
    }

    try {
      const contextPrompt = CONTEXT_PROMPTS[context] || CONTEXT_PROMPTS.general;
      const lengthInstruction = maxLength 
        ? `Keep the response under ${maxLength} characters.` 
        : "Keep the response concise but complete.";

      const fullPrompt = `${contextPrompt}

Generate content based on this prompt:
"""
${prompt}
"""

${lengthInstruction}

Provide ONLY the generated content, no explanations or metadata.`;

      const result = await this.executeWithFallback((model) => model.generateContent(fullPrompt));
      const response = result.response;
      const generatedText = response.text();


      return {
        success: true,
        text: generatedText.trim(),
        tokensUsed: response.usageMetadata?.totalTokenCount,
      };
    } catch (error: any) {
      console.error("[AIService] Generation failed:", error);
      return {
        success: false,
        error: error.message || "Failed to generate text",
      };
    }
  }
}

// Export singleton instance
export const aiService = new AIService();
export default AIService;
