# Vendored code

## cordis

| Field    | Value                                                        |
| -------- | ------------------------------------------------------------ |
| Upstream | https://github.com/cordiverse/cordis (`packages/core`)       |
| Version  | 4.0.0-rc.12                                                  |
| Commit   | `35fdc969e4b6c48c48ed44717c7a018324e4dd88`                   |
| License  | MIT (`vendor/cordis/LICENSE`)                                |
| Location | `vendor/cordis/src`, upstream tests in `vendor/cordis/tests` |

Third-party dependencies of the vendored code stay on npm: `cosmokit`, `@standard-schema/spec`.

Not vendored: `loader`, `hmr`, `include`, `group`, `timer`, `logger-console`. Config layering lives in `src/config`, and plugin loading and reconciliation live in `@docleus/server` (`PluginHost`). File-watching hot reload is not implemented yet; config changes are applied by calling `PluginHost.apply` again.

### Tooling adaptations (no source changes)

- `vendor/cordis/tsconfig.json` is ours. It compiles the vendored source with upstream's looser flags and emits declarations only; the strict project references it.
- Oxlint, Prettier, and dependency-cruiser skip `vendor/`.
- `vendor/cordis/tests/decorator.spec.ts` is excluded from the test run. It uses TC39 decorator syntax, which our test toolchain (oxc) cannot lower. Docleus code does not use decorators.

### Local patches

None yet. Express any change as a file under `patches/` and list it here.

### Review against the DeepSeek Harness vendor (rc.7 + local patches)

DSH's lifecycle hardening of `fiber.ts` (reentrant disposal) targeted rc.7. Upstream rc.12 restructured the fiber internals, so those patches do not apply as-is. `tests/hot-reload.test.ts` covers the behavior we depend on (unload removes listeners, services and effects; consumers wait for providers; config updates reload without leaks). Port a DSH fix only when a failing test shows it is still needed.
