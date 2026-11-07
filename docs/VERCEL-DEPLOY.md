# Vercel site and console preview

Production URL: https://getneverdown.vercel.app

The Vercel project serves a static build of `apps/web/public`. The homepage is `/`, the five-card console is `/console.html`, and the SDK example is `/sdk.html`. The root `vercel.json` runs `scripts/build-vercel-static.mjs`, which copies those pages, `console.css`, logo images, fonts, and font license to `dist-vercel`. No Hedera, Arkiv, or signing credentials are sent to Vercel.

The hosted preview intentionally labels live gateway status and agent actions as local-only. Its side chat can explain the workflow, but live status and evidence answers require the local console. The chat cannot initiate purchases or change policy. The backend uses a continuously running gateway/coordinator and persistent SQLite ledgers; these services are not deployed with this static site. Vercel Functions do not provide shared persistent SQLite storage. Do not describe the Vercel preview as a live resilience operator.

The first production deployment was verified on 2026-11-06: `/`, `/light-nd.png`, `/dark-nd.png`, and `/fonts/Redaction50-Regular.woff2` all returned HTTP 200. The hyphen-free URL was added as a project domain and its page and logo were verified publicly. The deployment project is `neverdown` in the `dhanushs-projects-155e2530` Vercel scope.

Pushes to the connected GitHub repository can deploy the static console. To deploy the same source through the Vercel CLI from the repository root:

```bash
vercel
vercel --prod
```

Run the backend locally with the separate profiles described in `docs/LIVE-BACKEND-ACCEPTANCE.md`. A later production deployment needs an always-on backend host, persistent database, protected internal gateway API, and a public API design before the console controls can operate remotely.
