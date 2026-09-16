import { z } from "zod";

export const FeatureRequestSchema = z.object({
  category: z.string().min(1, "Category is required"),
  urgency: z.enum(["Low", "Medium", "High"]).default("Medium"),
  title: z.string().min(1, "Title is required").max(100),
  description: z.string().min(1, "Description is required"),
});
