# Dogfood projects: requirements for a shared MarketingOS MVP

_Primary-source review performed 2026-08-30. Local repositories were inspected read-only; public claims were checked against each product's live first-party site. “Inference” sections are product recommendations, not established facts._

## Executive conclusion

The three projects support a common MarketingOS, but not a common funnel:

- **KeepAnalog** is an Argentina-focused prelaunch offer. Its immediate marketing job is demand validation and lead capture.
- **partnr** is an early-access B2B product for Argentine small businesses. Its immediate job is qualified demo acquisition and follow-up.
- **VinylOS** is a live consumer product with public catalog pages and product-led sharing. Its immediate job is organic discovery, signup, activation, retention, and referrals.

The MVP should therefore be a **separate, repo-aware control plane** with a small configuration manifest per project. It should normalize measurement, audits, experiments, content, approvals, and channel delivery while letting every project define its own audience, funnel events, page types, product data, brand, and deployment rules. Building the system inside any one of these apps would bake in the wrong assumptions for the other two.

## Verified facts by project

### KeepAnalog (`scrollapapel-com`, [live site](https://keepanalog.com/))

**Product and audience.** KeepAnalog turns links selected by a user into a personal printed edition for slower, off-screen reading. The site explicitly identifies Argentina, `es-AR`, and prelaunch status; pricing is not available and the intended WhatsApp intake channel is still disabled ([customer experience copy](/Users/bautistapessagno/Proyectos/scrollapapel-com/src/content/customer-experience.es-AR.ts:1), [landing composition](/Users/bautistapessagno/Proyectos/scrollapapel-com/src/app/page.tsx:19)). The live site matches those claims.

**Current marketing surface.** This is a static, single-route editorial landing page ([README](/Users/bautistapessagno/Proyectos/scrollapapel-com/README.md:1)). It has basic title/description metadata and a production origin ([layout](/Users/bautistapessagno/Proyectos/scrollapapel-com/src/app/layout.tsx:22)), plus a generated 1200×630 Open Graph image ([OG image](/Users/bautistapessagno/Proyectos/scrollapapel-com/src/app/opengraph-image.tsx:3)). Repository-wide searches found no analytics SDK, custom event tracking, form/API, email integration, CRM, sitemap, robots route, JSON-LD, or active WhatsApp link. The dependency list is only Next.js, React, and a visual shader package ([package](/Users/bautistapessagno/Proyectos/scrollapapel-com/package.json:10)).

**Available brand/content data.** The copy is centralized in a typed locale file, the palette and typography are explicit CSS tokens ([brand CSS](/Users/bautistapessagno/Proyectos/scrollapapel-com/src/app/globals.css:14)), and the repo contains product photography, logo explorations, an OG generator, and a finished 24-second campaign video with provenance ([campaign provenance](/Users/bautistapessagno/Proyectos/scrollapapel-com/artifacts/keepanalog-ad/PROVENANCE.md:1)). This is unusually good source material for content generation.

**Deployment constraints.** It is Next.js 16/React 19, pnpm, and pins Node 24.14.0 ([package](/Users/bautistapessagno/Proyectos/scrollapapel-com/package.json:10), [.nvmrc](/Users/bautistapessagno/Proyectos/scrollapapel-com/.nvmrc:1)). The live response is served by Vercel.

### partnr (`partnr`, [live site](https://partnr-ai.com/))

**Product and audience.** partnr presents itself as an autonomous agent for small Argentine businesses, covering operations, sales, marketing, and finance while requesting approval before spending or sending ([landing page](/Users/bautistapessagno/Proyectos/partnr/app/page.tsx:103)). The public conversion is an early-access demo request. The request stores name, email, company, business stage, and idea, then attempts owner and prospect emails ([route](/Users/bautistapessagno/Proyectos/partnr/app/api/demo-requests/route.ts:7), [lead table](/Users/bautistapessagno/Proyectos/partnr/db/schema.ts:1640)).

**Current marketing, analytics, SEO, and GEO surface.** It mounts Vercel Analytics and Speed Insights and defines canonical metadata, Open Graph/Twitter cards, Organization/WebSite structured data, and Argentina/Spanish entity grounding ([layout](/Users/bautistapessagno/Proyectos/partnr/app/layout.tsx:35)). The landing adds `SoftwareApplication` JSON-LD ([landing page](/Users/bautistapessagno/Proyectos/partnr/app/page.tsx:57)). Its sitemap currently contains only the landing page ([sitemap](/Users/bautistapessagno/Proyectos/partnr/app/sitemap.ts:4)). No custom acquisition/conversion event calls were found, so the code establishes traffic analytics but not a first-party funnel.

**Existing reusable execution capabilities.** The provider contract already models Gmail, WhatsApp, Facebook, Instagram, X, GitHub, Vercel, and Mercado Pago with explicit capabilities ([provider types](/Users/bautistapessagno/Proyectos/partnr/lib/integrations/types.ts:3)). Execution code sends X posts/DMs, Facebook posts, Instagram media, and WhatsApp messages ([channel executor](/Users/bautistapessagno/Proyectos/partnr/lib/integrations/execute.ts:40)); approved email is delivered through Resend with Gmail as Reply-To ([email integration](/Users/bautistapessagno/Proyectos/partnr/lib/integrations/email.ts:69)). GitHub/Vercel site generation and deployment are also first-class parts of the product ([README](/Users/bautistapessagno/Proyectos/partnr/README.md:9)).

**Existing customer and brand data.** Each business can retain its brief, design system, competitors, site URLs, and connection state ([business schema](/Users/bautistapessagno/Proyectos/partnr/db/schema.ts:101)). Design captures palette, fonts, logo, reference site, and notes ([design model](/Users/bautistapessagno/Proyectos/partnr/lib/design.ts:1)). Customer records have normalized phone/email identity, and deterministic segmentation distinguishes active, cooling, lost, and never-purchased customers ([customer schema](/Users/bautistapessagno/Proyectos/partnr/db/schema.ts:1297), [segmentation](/Users/bautistapessagno/Proyectos/partnr/lib/customers/derive.ts:130)). Uploaded data, context, and brand documents are durable inputs ([document schema](/Users/bautistapessagno/Proyectos/partnr/db/schema.ts:485)).

**Important boundary.** The database still has `marketing` and `seo` metric enum values, but the current writable metric contract deliberately permits only KPI, finance, and channel metrics because the marketing subagent was removed ([metric contract](/Users/bautistapessagno/Proyectos/partnr/lib/metricGroups.ts:3)). Likewise, `marketing` is historical but unproducible as a work domain ([work-domain contract](/Users/bautistapessagno/Proyectos/partnr/lib/workDomains.ts:3)). partnr supplies valuable connectors and domain patterns, but it is not currently the shared MarketingOS.

**Deployment constraints.** It is a Next.js 16/React 19 application backed by Postgres/Drizzle, Better Auth, Trigger.dev, Vercel Blob, AI SDKs, and Resend ([package](/Users/bautistapessagno/Proyectos/partnr/package.json:22)). Work spans both Vercel and Trigger.dev environments; OAuth credentials and connection state are per business ([README](/Users/bautistapessagno/Proyectos/partnr/README.md:122)).

### VinylOS (`VinylOS`, [live site](https://www.misvinilos.com/))

**Product and audience.** VinylOS is a Spanish-language consumer product for tracking a vinyl collection, viewing “Wrapped” statistics, following friends, and discovering records. Discogs supplies catalog data and Last.fm supplies charts/artist metadata ([README](/Users/bautistapessagno/Proyectos/VinylOS/README.md:1)). The live landing promises exact-edition search, social discovery, and a year-in-vinyl view, consistent with the local page ([landing](/Users/bautistapessagno/Proyectos/VinylOS/app/(marketing)/page.tsx:71)).

**Current marketing, analytics, SEO, and sharing.** It mounts Vercel Analytics, has canonical/Open Graph/Twitter metadata, and uses the production origin rather than preview domains ([layout](/Users/bautistapessagno/Proyectos/VinylOS/app/layout.tsx:28), [site constants](/Users/bautistapessagno/Proyectos/VinylOS/lib/site.ts:1)). Robots rules exclude signed-in surfaces ([robots](/Users/bautistapessagno/Proyectos/VinylOS/app/robots.ts:4)). The hourly sitemap combines static routes with database-backed album and artist pages ([sitemap](/Users/bautistapessagno/Proyectos/VinylOS/app/sitemap.ts:6)). Album and artist pages generate specific canonical metadata, social cards, and `MusicAlbum`/`MusicGroup` JSON-LD ([album metadata](/Users/bautistapessagno/Proyectos/VinylOS/app/(public)/album/[id]/page.tsx:22), [artist page](/Users/bautistapessagno/Proyectos/VinylOS/app/(public)/artist/[id]/page.tsx:20)). Public profiles are shareable but intentionally `noindex`, preserving a useful privacy boundary ([profile metadata](/Users/bautistapessagno/Proyectos/VinylOS/app/(public)/users/[userId]/page.tsx:45)). A reusable Web Share/clipboard control is used across albums, artists, collections, wishlists, and friend invites ([share control](/Users/bautistapessagno/Proyectos/VinylOS/app/(app)/ShareLinkButton.tsx:80)).

Repository-wide searches found no custom analytics events, email/newsletter infrastructure, CRM, or social publishing connector. Vercel Analytics therefore measures visits, but the source does not establish signup, first-record, share, follow, wishlist, or retention funnels.

**Available product/content data.** The shared catalog stores release titles, year, country, artwork, formats, genres, styles, label/catalog number, artists, and profiles; user data includes collections, wishlists, recommendations, and follows ([schema](/Users/bautistapessagno/Proyectos/VinylOS/lib/db/schema.ts:29)). This is a strong base for programmatic SEO and editorial/social content, provided third-party data licenses and attribution requirements are checked before republishing beyond the product.

**Deployment constraints.** It is Next.js 16/React 19 with Neon/Postgres, Drizzle, Better Auth, shared Discogs/Last.fm credentials, and Node 22+ ([README](/Users/bautistapessagno/Proyectos/VinylOS/README.md:8), [package](/Users/bautistapessagno/Proyectos/VinylOS/package.json:18)). CI runs lint, tests, a production build, and a Server Action verification step ([CI](/Users/bautistapessagno/Proyectos/VinylOS/.github/workflows/ci.yml:1)).

## Inference: shared MVP boundary

### Build first

1. **Project registry and manifest.** One record per project: local repo path, GitHub repo, production URL, market/locale, lifecycle stage, audience, offer, conversion definition, activation/retention events, brand sources, public page patterns, analytics source, approved channels, and deploy/approval policy.
2. **Evidence snapshot.** Read the repo and production URL; inventory metadata, canonicals, robots, sitemaps, JSON-LD, public routes, CTAs, forms, analytics calls, assets, and deploy constraints. Store evidence and timestamp so recommendations are auditable.
3. **Common event and funnel layer.** Define a small event envelope (`project`, anonymous/user identity where lawful, event, URL/referrer/UTMs, timestamp, properties) but configure the funnel per project. Generate instrumentation patches as reviewed PRs rather than editing production apps invisibly.
4. **SEO/GEO workbench.** Audit indexability, page templates, structured data, entity consistency, internal links, freshness, and content gaps; produce prioritized changes and PR-ready patches. Record citations/sources used in public content. Do not collapse GEO into a vanity score: measure answer-engine referrals and cited/mentioned pages when a reliable source becomes available.
5. **Experiment loop.** Hypothesis → target metric → approved change/content → distribution → observation window → outcome/decision. A weekly project brief should show acquisition, conversion, activation/retention, shipped work, anomalies, and next actions.
6. **Content and distribution queue.** Generate briefs/drafts from verified product and brand data, preserve locale/voice, attach provenance, require approval, and then dispatch through channel adapters. partnr's provider contracts are the best existing implementation reference; reuse/extract those boundaries rather than coupling MarketingOS to partnr's database.

### Configure, do not hard-code

| Concern | KeepAnalog | partnr | VinylOS |
|---|---|---|---|
| Primary conversion | Join waitlist / start WhatsApp intake | Submit qualified demo request | Create account |
| Activation | Submit first set of links (not implemented yet) | Connect a business and reach first useful agent outcome | Add first record / complete initial collection action |
| Retention | Repeat monthly edition (future) | Recurring owner use and completed business work | Return usage, collection growth, follows/wishlist/discovery |
| Strongest acquisition asset | Editorial brand, product photography, campaign video | B2B problem/solution proof and demo flow | Programmatic album/artist pages and shareable product objects |
| Immediate instrumentation need | CTA/form and source attribution | Demo-submit and qualified-demo lifecycle | Signup, first record, search, share, follow, wishlist, return cohorts |
| Content data | Centralized copy and owned visuals | Brief, design, competitors, customer/operations context | Catalog, genres, artists, releases, user-generated collection signals |

### Reuse from existing projects

- From **partnr**: provider abstractions, OAuth/token storage patterns, approval-gated channel actions, Resend delivery, GitHub/Vercel adapters, business/design/competitor schemas, and durable job execution.
- From **VinylOS**: dynamic sitemap pattern, page-specific metadata/JSON-LD, canonical handling, noindex privacy decisions, and share component/event candidates.
- From **KeepAnalog**: centralized brand copy/tokens, owned media library, and explicit asset provenance.

Reuse should happen behind MarketingOS-owned interfaces or extracted packages. Direct imports across three application repos would make independent deploys and migrations brittle.

### Explicit MVP non-goals

- Autonomous ad buying or spending.
- Unreviewed public posting, bulk outreach, or customer messaging.
- A replacement CRM, website builder, or product analytics warehouse.
- A universal funnel or universal “marketing score.”
- Scraping/private-data ingestion without an explicit connector and permission model.

## Unknowns that must remain explicit

The sources do **not** establish production traffic/conversion counts, access to Vercel Analytics properties, Search Console/Bing/answer-engine data, social account ownership and scopes, consent/privacy requirements for new tracking, target geographies beyond the visible Spanish/Argentina signals, budgets, content cadence, or the commercial license for reusing Discogs/Last.fm data in off-product marketing. They also do not establish a current GEO measurement method or whether any product is cited by answer engines.

Before implementation, each project needs one short manifest review to lock its north-star metric, event names, legal/consent posture, connected accounts, and approval policy. Those unknowns should block sending/spending—not the read-only audit, draft generation, or instrumentation-PR parts of the MVP.
