import { z } from "zod";
import {
  WebsiteSchema,
  PageSchema,
  SectionSchema,
  NavigationSchema,
  PageUpdateSchema,
} from "./website";

export const websiteSchemas = {
  init: WebsiteSchema.partial(),
  save: WebsiteSchema.partial(),
  publish: z.object({
    isLive: z.boolean(),
    domain: z.string().optional(),
    subdomain: z.string().optional(),
  }),
  page: z.union([
    z.object({ action: z.literal("add"), page: PageSchema }),
    z.object({
      action: z.literal("update"),
      pageId: z.string(),
      updates: PageUpdateSchema,
    }),
    z.object({ action: z.literal("delete"), pageId: z.string() }),
  ]),
  section: z.union([
    z.object({
      action: z.literal("add"),
      pageId: z.string(),
      section: SectionSchema,
    }),
    z.object({
      action: z.literal("update"),
      pageId: z.string(),
      sectionId: z.string(),
      updates: SectionSchema.partial(),
    }),
    z.object({
      action: z.literal("delete"),
      pageId: z.string(),
      sectionId: z.string(),
    }),
    z.object({
      action: z.literal("toggle"),
      pageId: z.string(),
      sectionId: z.string(),
    }),
    z.object({
      action: z.literal("reorder"),
      pageId: z.string(),
      orderedIds: z.array(z.string()).min(1),
    }),
  ]),
  navigation: z.object({
    navigation: NavigationSchema,
  }),
  checkSubdomain: z.object({
    subdomain: z.string(),
  }),
};
