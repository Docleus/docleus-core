import { startIslands } from "./islands.ts";

await startIslands(document, (url) => import(/* @vite-ignore */ url));
