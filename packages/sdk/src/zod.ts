/**
 * The zod version the host runs, for plugins to validate external input
 * (HTTP bodies, config, block attrs, stored data) without bundling their own
 * copy. Server entries get it from the host's `@docleus/sdk`; browser
 * entries through the import map.
 *
 * @stability experimental
 */
export { z } from "zod";
