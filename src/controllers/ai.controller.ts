/**
 * AI Controller
 * Handles AI text enhancement and generation endpoints
 */

import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { aiService, AIAction, AIContext } from "../services/ai.service";
import {
  isAgentPanelEnabled,
  resolveAgentProvider,
} from "../services/ai/agent-settings.service";

export class AIController {
  /**
   * POST /api/ai/enhance
   * Enhance existing text with AI
   */
  async enhanceText(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { text, action, context, additionalInstructions } = req.body;

      // Validate action
      const validActions: AIAction[] = ["improve", "expand", "shorten", "professional"];
      if (!validActions.includes(action)) {
        return res.status(400).json({
          success: false,
          error: "invalid_action",
          message: `Invalid action. Must be one of: ${validActions.join(", ")}`,
        });
      }

      // Validate context
      const validContexts: AIContext[] = [
        "product_description",
        "post_content",
        "campaign_email",
        "event_description",
        "business_bio",
        "session_description",
        "general",
      ];
      if (context && !validContexts.includes(context)) {
        return res.status(400).json({
          success: false,
          error: "invalid_context",
          message: `Invalid context. Must be one of: ${validContexts.join(", ")}`,
        });
      }

      const result = await aiService.enhanceText({
        text,
        action: action as AIAction,
        context: (context || "general") as AIContext,
        additionalInstructions,
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: "enhancement_failed",
          message: result.error,
        });
      }

      return res.json({
        success: true,
        data: {
          original: text,
          enhanced: result.text,
          action,
          tokensUsed: result.tokensUsed,
        },
      });
    } catch (error: any) {
      console.error("[AIController.enhanceText] Error:", error);
      return res.status(500).json({
        success: false,
        error: "internal_error",
        message: error.message || "Failed to enhance text",
      });
    }
  }

  /**
   * POST /api/ai/generate
   * Generate new text from a prompt
   */
  async generateText(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { prompt, context, maxLength } = req.body;

      // Validate context
      const validContexts: AIContext[] = [
        "product_description",
        "post_content",
        "campaign_email",
        "event_description",
        "business_bio",
        "session_description",
        "general",
      ];
      if (context && !validContexts.includes(context)) {
        return res.status(400).json({
          success: false,
          error: "invalid_context",
          message: `Invalid context. Must be one of: ${validContexts.join(", ")}`,
        });
      }

      const result = await aiService.generateText({
        prompt,
        context: (context || "general") as AIContext,
        maxLength: maxLength ? Number(maxLength) : undefined,
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: "generation_failed",
          message: result.error,
        });
      }

      return res.json({
        success: true,
        data: {
          prompt,
          generated: result.text,
          tokensUsed: result.tokensUsed,
        },
      });
    } catch (error: any) {
      console.error("[AIController.generateText] Error:", error);
      return res.status(500).json({
        success: false,
        error: "internal_error",
        message: error.message || "Failed to generate text",
      });
    }
  }

  /**
   * GET /api/ai/status
   * Check AI service availability
   */
  async getStatus(req: SupabaseRequest, res: Response): Promise<Response> {
    const available = aiService.isAvailable();
    const agentEnabled = await isAgentPanelEnabled();

    return res.json({
      success: true,
      data: {
        available,
        model: available ? "gemini-1.5-flash" : null,
        // Dashboard agent panel gate — FE renders the panel only when true.
        agent: {
          enabled: agentEnabled,
          provider: agentEnabled ? (await resolveAgentProvider()).name : null,
        },
      },
    });
  }
}

export const aiController = new AIController();
