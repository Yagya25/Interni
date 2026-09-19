import type { MetadataRoute } from "next";
import { routes, site } from "@/config/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: new URL(routes.home, site.url).toString(), changeFrequency: "monthly", priority: 1 }];
}
