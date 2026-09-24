# OmniHilbras

A landing page for **OmniHilbras**, an intelligent, self-hostable AI gateway.

The first slice focuses on the product story and visual language: a warm editorial
surface, gold routing accents, a live gateway preview, and a responsive light/dark
theme inspired by the Hilbras Code design system.

The local dashboard is a client-side app at `/dashboard.html`. Its routes are
hash-based so they work on any static host without server rewrites:

- `#/overview`
- `#/providers`
- `#/providers/:providerId`
- `#/routing`

The standalone HTML entry files remain available as direct-entry fallbacks, but
internal dashboard navigation no longer reloads the document. All dashboard
surfaces use preview data until the gateway API is connected.

## Scripts

```bash
pnpm install
pnpm dev
pnpm build
pnpm typecheck
```
