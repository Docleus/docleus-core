/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-deep-import-into-package-internals",
      severity: "error",
      comment: "Import other packages through their public entry only.",
      from: { path: "^packages/([^/]+)/src" },
      to: {
        path: "^packages/[^/]+/src/(?!index\\.ts$)",
        pathNot: "^packages/$1/",
      },
    },
    {
      name: "kernel-depends-only-on-itself",
      severity: "error",
      from: { path: "^packages/kernel/src" },
      to: { path: "^packages/(?!kernel/)[^/]+/src" },
    },
    {
      name: "sdk-depends-only-on-kernel",
      severity: "error",
      from: { path: "^packages/sdk/src" },
      to: { path: "^packages/(?!(sdk|kernel)/)[^/]+/src" },
    },
    {
      name: "core-plugins-depend-on-sdk",
      severity: "error",
      from: { path: "^packages/core-[^/]+/src" },
      to: { path: "^packages/kernel/src" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "/vendor/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
  },
};
