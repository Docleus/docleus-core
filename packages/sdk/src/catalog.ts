import type { ExtensionPoint } from "./declare.ts";

/**
 * Renders extension points as the Markdown extension catalog.
 *
 * @stability experimental
 */
export function renderCatalog(points: readonly ExtensionPoint[]): string {
  const events = points.filter((point) => point.kind === "event");
  const services = points.filter((point) => point.kind === "service");
  const lines = [
    "# Extension catalog",
    "",
    "Generated from the SDK declarations. Do not edit by hand.",
    "",
    "## Events",
    "",
  ];
  if (events.length === 0) {
    lines.push("None yet.", "");
  } else {
    lines.push(
      "| Name | Mode | Stability | Description |",
      "| --- | --- | --- | --- |",
    );
    for (const event of events.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      lines.push(
        `| \`${event.name}\` | ${event.mode} | ${event.stability} | ${event.description} |`,
      );
    }
    lines.push("");
  }
  lines.push("## Services", "");
  if (services.length === 0) {
    lines.push("None yet.", "");
  } else {
    lines.push("| Name | Stability | Description |", "| --- | --- | --- |");
    for (const service of services.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      lines.push(
        `| \`${service.name}\` | ${service.stability} | ${service.description} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
