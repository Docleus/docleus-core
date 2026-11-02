import { fileURLToPath } from "node:url";

/** The built app (`pnpm --filter @docleus/app build`), which `docleus serve` serves under `/_app/`. */
export const APP_DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));

/** The built site runtime (`dist-site/`), copied into every published site under `_assets/docleus/`. */
export const SITE_RUNTIME_DIR = fileURLToPath(
  new URL("../dist-site/", import.meta.url),
);
