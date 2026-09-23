export interface BusinessCategory {
  id: string;
  slug: string;
  label: string;
  parent_id: string | null;
  subcategories?: BusinessCategory[];
}

export const DEFAULT_BUSINESS_CATEGORIES: BusinessCategory[] = [
  {
    id: "retail",
    slug: "retail",
    label: "Retail & Shopping",
    parent_id: null,
    subcategories: [
      { id: "clothing-apparel", slug: "clothing-apparel", label: "Clothing & Apparel", parent_id: "retail" },
      { id: "shoes-footwear", slug: "shoes-footwear", label: "Shoes & Footwear", parent_id: "retail" },
      { id: "jewelry-accessories", slug: "jewelry-accessories", label: "Jewelry & Accessories", parent_id: "retail" },
      { id: "beauty-cosmetics", slug: "beauty-cosmetics", label: "Beauty & Personal Care", parent_id: "retail" },
      { id: "electronics-gadgets", slug: "electronics-gadgets", label: "Electronics & Gadgets", parent_id: "retail" },
      { id: "home-living", slug: "home-living", label: "Home, Furniture & Living", parent_id: "retail" },
      { id: "groceries-supermarket", slug: "groceries-supermarket", label: "Groceries & Supermarket", parent_id: "retail" },
      { id: "general-merchandise", slug: "general-merchandise", label: "General Merchandise", parent_id: "retail" },
    ],
  },
  {
    id: "food-beverage",
    slug: "food-beverage",
    label: "Food & Beverage",
    parent_id: null,
    subcategories: [
      { id: "restaurant", slug: "restaurant", label: "Restaurant & Dining", parent_id: "food-beverage" },
      { id: "cafe-coffee", slug: "cafe-coffee", label: "Cafe & Coffee Shop", parent_id: "food-beverage" },
      { id: "bakery-pastry", slug: "bakery-pastry", label: "Bakery & Pastries", parent_id: "food-beverage" },
      { id: "fast-food", slug: "fast-food", label: "Fast Food & Quick Service", parent_id: "food-beverage" },
      { id: "bar-lounge", slug: "bar-lounge", label: "Bar & Lounge", parent_id: "food-beverage" },
      { id: "catering-events", slug: "catering-events", label: "Catering & Private Chef", parent_id: "food-beverage" },
      { id: "food-truck", slug: "food-truck", label: "Food Truck & Street Food", parent_id: "food-beverage" },
    ],
  },
  {
    id: "services",
    slug: "services",
    label: "Professional & Personal Services",
    parent_id: null,
    subcategories: [
      { id: "consulting-professional", slug: "consulting-professional", label: "Consulting & Legal", parent_id: "services" },
      { id: "design-creative", slug: "design-creative", label: "Design & Creative Services", parent_id: "services" },
      { id: "marketing-advertising", slug: "marketing-advertising", label: "Marketing & PR", parent_id: "services" },
      { id: "health-wellness", slug: "health-wellness", label: "Health, Spa & Wellness", parent_id: "services" },
      { id: "education-tutoring", slug: "education-tutoring", label: "Education & Coaching", parent_id: "services" },
      { id: "it-software-services", slug: "it-software-services", label: "IT & Software Services", parent_id: "services" },
      { id: "repair-maintenance", slug: "repair-maintenance", label: "Repair & Maintenance", parent_id: "services" },
    ],
  },
  {
    id: "digital-creator",
    slug: "digital-creator",
    label: "Digital Products & Creator",
    parent_id: null,
    subcategories: [
      { id: "online-courses", slug: "online-courses", label: "Online Courses & Training", parent_id: "digital-creator" },
      { id: "digital-downloads", slug: "digital-downloads", label: "Digital Downloads & E-books", parent_id: "digital-creator" },
      { id: "content-media", slug: "content-media", label: "Content Creation & Media", parent_id: "digital-creator" },
      { id: "saas-software", slug: "saas-software", label: "Software & SaaS", parent_id: "digital-creator" },
      { id: "memberships-communities", slug: "memberships-communities", label: "Memberships & Communities", parent_id: "digital-creator" },
    ],
  },
  {
    id: "entertainment-events",
    slug: "entertainment-events",
    label: "Events, Arts & Entertainment",
    parent_id: null,
    subcategories: [
      { id: "event-organizer", slug: "event-organizer", label: "Event Ticketing & Conferences", parent_id: "entertainment-events" },
      { id: "arts-culture", slug: "arts-culture", label: "Art Galleries & Crafts", parent_id: "entertainment-events" },
      { id: "sports-fitness", slug: "sports-fitness", label: "Sports & Fitness Centers", parent_id: "entertainment-events" },
      { id: "photography-video", slug: "photography-video", label: "Photography & Videography", parent_id: "entertainment-events" },
    ],
  },
];
