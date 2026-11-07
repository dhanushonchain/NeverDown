# `@neverdown/web`

The console uses self-hosted Redaction 50 for its UI text. Regular, bold, and italic WOFF2 files live in `public/fonts/`; their upstream SIL Open Font License is included as `public/fonts/OFL.txt`. Source: https://github.com/jeremymickel/Redaction.

The current console is served as static HTML by `src/server.ts`; it has TypeScript on the server, but does not yet have React, Tailwind CSS, or shadcn/ui. The curtain animation is integrated directly into `public/index.html` so it works in the current app. The reusable React version and demo are in `components/ui/curtain-theme-toggle.tsx` and `components/ui/demo.tsx`. They are source files for a future React frontend and are not bundled by the current server.

To use the TSX component in this app, first set up a React frontend (for example Next.js with TypeScript and Tailwind), then run `pnpm dlx shadcn@latest init` in that frontend. Choose `components/ui` as the UI component path and configure the `@/components` alias in its TypeScript config. Keep this folder as the default location so shadcn-generated components and imports such as `@/components/ui/curtain-theme-toggle` resolve consistently. Install `react`, `react-dom`, `@types/react`, and `@types/react-dom` if the frontend setup does not supply them. The component itself needs no icon or image package; it includes SVG icons and uses no image assets.

NeverDown landing page and five-act console.

The current frontend is static HTML served by a TypeScript Node.js server. The homepage is `public/index.html`; the console is `public/console.html`. The production build emits the server under `dist/apps/web/src/server.js`; run it from this package with `npm start` or from the repository root with `npm start`.

The server exposes incident/evidence endpoints and local operator endpoints. The hosted Vercel output is intentionally a static preview; live operations require the local backend services.

For setup and commands, see [Local development](../../docs/LOCAL-DEVELOPMENT.md).
