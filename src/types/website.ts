import { z } from "zod";

export const DesignSettingsSchema = z.object({
  brand: z.object({
    siteName: z.string().min(1),
    logo: z.string().url().nullable(),
    tagline: z.string().default(""),
    favicon: z.string().url().optional(),
  }),
  typography: z.object({
    headingFont: z.string().min(1),
    bodyFont: z.string().min(1),
  }),
  colors: z.object({
    primary: z.string().min(1),
    accent: z.string().min(1),
    background: z.string().min(1),
    secondary: z.string().optional(),
    text: z.string().optional(),
    link: z.string().optional(),
  }),
});

export type NavigationItem = {
  label: string;
  url: string;
  icon?: string;
  children?: NavigationItem[];
  openInNewTab?: boolean;
};
export const NavigationItemSchema: z.ZodType<NavigationItem> = z.lazy(() =>
  z.object({
    label: z.string().min(1),
    url: z.string().min(1),
    icon: z.string().optional(),
    visible: z.boolean().default(true),
    openInNewTab: z.boolean().optional(),
  }),
);

export const NavigationSchema = z.object({
  logo: z.string().nullable(),
  items: z.array(NavigationItemSchema).default([]),
  ctaButton: z
    .object({
      text: z.string(),
      link: z.string(),
      style: z.enum(["primary", "secondary", "outline", "text"]).optional(),
      icon: z.string().optional(),
    })
    .optional(),
  mobileMenuEnabled: z.boolean().default(true),
});

export const SectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum([
    "welcome-banner",
    "banner",
    "cards",
    "hero",
    "content",
    "newsletter",
    "gallery",
    "footer",
    "custom",
    // Store Section Types
    "store-featured-products",
    "store-product-list",
    "store-categories",
    "store-hero",
    "store-cart",
    // Event Section Types
    "event-list",
    "event-featured",
    // Publication Section Types
    "publication-posts",
    "publication-featured",
  ]),
  visible: z.boolean(),
  order: z.number().int(),
  content: z.any(),
  // Optional entity linkage for dynamic data fetching
  linkedEntity: z
    .object({
      type: z.enum(["store", "event", "publication"]).optional(),
      id: z.string().optional(),
      slug: z.string().optional(),
    })
    .optional(),
  customStyles: z
    .object({
      backgroundColor: z.string().optional(),
      padding: z.string().optional(),
      margin: z.string().optional(),
      className: z.string().optional(),
    })
    .optional(),
});

export const WebsiteNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.enum(["page", "section", "block", "component", "element"]),
    componentType: z.string().optional(),
    blockType: z.string().optional(),
    category: z.string().optional(),
    styles: z.record(z.string(), z.any()).optional(),
    content: z.record(z.string(), z.any()).optional(),
    children: z.array(WebsiteNodeSchema).optional(),
  }),
);

export const PageSchema = z.object({
  metadata: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    icon: z.string().optional(),
    required: z.boolean(),
    status: z.enum(["draft", "published", "disabled"]),
    lastUpdated: z.string(),
    createdAt: z.string(),
    seo: z
      .object({
        title: z.string(),
        description: z.string(),
        keywords: z.array(z.string()).optional(),
        ogImage: z.string().optional(),
        canonical: z.string().optional(),
        noindex: z.boolean().optional(),
      })
      .optional(),
  }),
  sections: z.array(SectionSchema),
  content: z.record(z.string(), z.any()).optional(), // The recursive block tree
  customCSS: z.string().optional(),
  customJS: z.string().optional(),
});

const PageMetadataUpdateSchema = z.object({
  name: z.string().optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  icon: z.string().optional(),
  required: z.boolean().optional(),
  status: z.enum(["draft", "published", "disabled"]).optional(),
  seo: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      keywords: z.array(z.string()).optional(),
      ogImage: z.string().optional(),
      canonical: z.string().optional(),
      noindex: z.boolean().optional(),
    })
    .optional(),
});

export const PageUpdateSchema = z
  .object({
    metadata: PageMetadataUpdateSchema.optional(),
    sections: z.array(SectionSchema).optional(),
    customCSS: z.string().optional(),
    customJS: z.string().optional(),
    content: z.record(z.string(), z.any()).optional(),
  })
  .refine((val) => Object.keys(val).length > 0, {
    message: "At least one field must be provided for update",
  });

export const WebsiteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  businessId: z.string().optional(),
  domain: z.string().optional(),
  subdomain: z.string().optional(),
  isLive: z.boolean(),
  design: DesignSettingsSchema,
  navigation: NavigationSchema,
  pages: z.array(PageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DesignSettings = z.infer<typeof DesignSettingsSchema>;
// NavigationItem type is declared above to break self-reference inference issue.
export type Navigation = z.infer<typeof NavigationSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type Page = z.infer<typeof PageSchema>;
export type PageUpdate = z.infer<typeof PageUpdateSchema>;
export type Website = z.infer<typeof WebsiteSchema>;

export const DefaultWebsite = (
  userId: string,
  id: string,
  businessId?: string,
): Website => ({
  id,
  userId,
  businessId,
  isLive: false,
  design: {
    brand: { siteName: "My Site", logo: null, tagline: "" },
    typography: { headingFont: "Inter", bodyFont: "Inter" },
    colors: { primary: "#111827", accent: "#2563eb", background: "#ffffff" },
  },
  navigation: {
    logo: null,
    items: [],
    mobileMenuEnabled: true,
  },
  pages: [
    {
      metadata: {
        id: "home",
        name: "Home",
        slug: "home",
        required: true,
        status: "draft",
        lastUpdated: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
      sections: [],
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

export const DomainSchema = z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/);
export const SubdomainSchema = z.string().regex(/^[a-z0-9-]+$/);
