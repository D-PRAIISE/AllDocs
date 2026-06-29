import type { MetadataRoute } from "next";

import { SEO_LANDINGS } from "@/lib/seo-landings";

const SITE_URL = "https://getalldocs.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/edit`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.9,
    },
    ...SEO_LANDINGS.map((l) => ({
      url: `${SITE_URL}/${l.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    })),
  ];
}
