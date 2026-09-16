import { Request, Response, NextFunction } from "express";
import { ParamsDictionary } from "express-serve-static-core";
import { z, ZodSchema } from "zod";
import { ParsedQs } from "qs";

/**
 * Validation middleware for Zod schemas
 * @param schema - Zod schema to validate against
 * @param type - Which part of the request to validate (body, query, params)
 * @returns Express middleware function
 */
export const validateRequest = (
  schema: ZodSchema,
  type: "body" | "query" | "params" = "body"
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // Get the correct data to validate based on type
      let dataToValidate;
      switch (type) {
        case "body":
          dataToValidate = req.body;
          break;
        case "query":
          dataToValidate = req.query;
          break;
        case "params":
          dataToValidate = req.params;
          break;
        default:
          dataToValidate = req.body;
      }

      // Validate with Zod
      const validated = schema.parse(dataToValidate);

      // Replace the appropriate request property with validated value
      switch (type) {
        case "body":
          req.body = validated;
          break;
        case "query":
          req.query = validated as typeof req.query;
          break;
        case "params":
          req.params = validated as typeof req.params;
          break;
      }

      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        // Helper to format a single issue
        const formatIssue = (issue: z.ZodIssue): string => {
          const path = issue.path.join(".");
          const prefix = path ? `${path}: ` : "";
          return `${prefix}${issue.message}`;
        };

        // Deeply search for the most relevant error in unions
        const getFriendlyErrorMessage = (error: z.ZodError): string => {
          // If it's a simple error, just join them
          if (!error.issues.some((i) => i.code === "invalid_union")) {
            return error.issues.map(formatIssue).join(", ");
          }

          // For unions, try to find the "best" error
          // Usually, it's the one that progressed furthest or has the most descriptive message
          // In the user's case, they sent a wrong 'action', so we should probably highlight that.
          
          const messages: string[] = [];
          
          for (const issue of error.issues) {
            if (issue.code === "invalid_union" && "unionErrors" in issue) {
              // Recursively get messages from union errors
              const unionMessages = (issue as any).unionErrors
                .map((ue: z.ZodError) => getFriendlyErrorMessage(ue))
                .filter(Boolean);
              
              // If all union errors are about the same field (e.g. 'action' literal mismatch)
              // We can summarize it.
              if (unionMessages.length > 0) {
                messages.push(unionMessages[0]); // Just take the first one as representative for now
              }
            } else {
              messages.push(formatIssue(issue));
            }
          }

          return Array.from(new Set(messages)).join(", ");
        };

        const errorMessage = getFriendlyErrorMessage(err);

        return res.status(400).json({
          success: false,
          error: "VALIDATION_ERROR",
          message: errorMessage,
        });
      }

      console.error("Validation middleware error:", err);
      return res.status(500).json({
        success: false,
        error: "VALIDATION_ERROR",
        message: "Validation error",
      });
    }
  };
};
