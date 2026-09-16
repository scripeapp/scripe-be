import { z } from "zod";

/**
 * Simplified version of the formatter from validation.middleware.ts for testing
 */
const formatIssue = (issue: z.ZodIssue): string => {
  const path = issue.path.join(".");
  const prefix = path ? `${path}: ` : "";
  return `${prefix}${issue.message}`;
};

const getFriendlyErrorMessage = (error: z.ZodError): string => {
  if (!error.issues.some((i) => i.code === "invalid_union")) {
    return error.issues.map(formatIssue).join(", ");
  }

  const messages: string[] = [];
  
  for (const issue of error.issues) {
    if (issue.code === "invalid_union" && "unionErrors" in issue) {
      const unionMessages = (issue as any).unionErrors
        .map((ue: z.ZodError) => getFriendlyErrorMessage(ue))
        .filter(Boolean);
      
      if (unionMessages.length > 0) {
        messages.push(unionMessages[0]);
      }
    } else {
      messages.push(formatIssue(issue));
    }
  }

  return Array.from(new Set(messages)).join(", ");
};

// Test schema similar to the one in the user request
const TestSchema = z.union([
  z.object({ action: z.literal("add"), value: z.string() }),
  z.object({ action: z.literal("update"), id: z.string() }),
]);

try {
  // Simulate invalid input: "toggleVisibility" instead of "add" or "update"
  TestSchema.parse({ action: "toggleVisibility" });
} catch (err) {
  if (err instanceof z.ZodError) {
    const message = getFriendlyErrorMessage(err);
    console.log("Formatted Error Message:");
    console.log(message);
    
    if (message.includes("expected \"add\"") || message.includes("expected \"update\"")) {
      console.log("\nSuccess: Error message is clean and relevant.");
    } else {
      console.log("\nFailure: Unexpected message format.");
    }
  }
}
