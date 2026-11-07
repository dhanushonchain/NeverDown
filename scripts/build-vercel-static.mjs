import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "apps", "web", "public");
const output = join(root, "dist-vercel");
const assets = [
  "index.html",
  "console.html",
  "console.css",
  "sdk.html",
  "light-nd.png",
  "dark-nd.png",
  "fonts/OFL.txt",
  "fonts/Redaction50-Regular.woff2",
  "fonts/Redaction50-Bold.woff2",
  "fonts/Redaction50-Italic.woff2",
];

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "fonts"), { recursive: true });
for (const asset of assets) cpSync(join(source, asset), join(output, asset));
console.log(`Copied ${assets.length} public assets to dist-vercel`);
