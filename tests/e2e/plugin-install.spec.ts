import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const PLUGIN = "@test/installable";
const fixtures = fileURLToPath(
  new URL("../../packages/server/tests/fixtures/", import.meta.url),
);

/** Packs the test plugin with the system `tar`, as an author would. */
function packFixture(): string {
  const out = join(mkdtempSync(join(tmpdir(), "docleus-tgz-")), "stamp.tgz");
  execFileSync("tar", ["-czf", out, "-C", fixtures, "installable"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return out;
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  const form = page.getByRole("form", { name: "Development sign-in" });
  await form.getByLabel("Email").fill("admin@example.com");
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("form", { name: "Create organization" }),
  ).toBeVisible();
}

async function createSpace(page: Page): Promise<string> {
  const org = page.getByRole("form", { name: "Create organization" });
  await org.getByLabel("Name").fill("E2E");
  await org.getByLabel("Slug").fill(uniqueSlug("org"));
  await org.getByRole("button", { name: "Create organization" }).click();
  await expect(page).toHaveURL(/\/orgs\/[^/?]+$/);
  await page
    .getByRole("main")
    .getByRole("button", { name: "New space" })
    .click();
  const space = page.getByRole("form", { name: "Create space" });
  await space.getByLabel("Name").fill("Docs");
  await space.getByLabel("Slug").fill(uniqueSlug("space"));
  await space.getByRole("button", { name: "Create space" }).click();
  await expect(page).toHaveURL(/\/orgs\/[^/]+\/spaces\/[^/]+$/);
  return new URL(page.url()).pathname;
}

test("an uploaded plugin's block is usable in the editor without a restart", async ({
  page,
}) => {
  await signIn(page);
  const spacePath = await createSpace(page);
  const orgPath = spacePath.replace(/\/spaces\/[^/]+$/, "");

  await page.goto("/");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Instance settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Installed plugins" })
    .click();
  await expect(page).toHaveURL("/settings/installed");
  await page.getByRole("button", { name: "Install a plugin…" }).click();
  const upload = page.getByRole("form", { name: "Upload plugin" });
  await upload.getByLabel("Tarball (.tgz)").setInputFiles(packFixture());
  await upload.getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(
    `Installed ${PLUGIN} 1.0.0. Enable it in an organization's plugin settings.`,
  );
  const installed = page.getByRole("table", { name: "Installed plugins" });
  await expect(installed.getByRole("row", { name: PLUGIN })).toContainText(
    "Upload stamp.tgz",
  );

  await page.goto(`${orgPath}/settings/plugins`);
  const enabled = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/plugins"),
  );
  // The switch is controlled: it shows the server's state after the PUT.
  const on = page
    .getByRole("group", { name: `Enable ${PLUGIN}` })
    .getByRole("button", { name: "On" });
  await on.click();
  expect((await enabled).ok()).toBe(true);
  await expect(on).toHaveAttribute("aria-pressed", "true");

  await page.goto(spacePath);
  await page
    .getByRole("button", { name: /^\+? ?New page$/ })
    .first()
    .click();
  const body = page.getByRole("textbox", { name: "Page body" });
  await expect(body).toBeVisible();
  await body.click();
  await page.keyboard.type("/stamp");
  await page
    .getByRole("listbox", { name: "Insert block" })
    .getByRole("option", { name: "Stamp" })
    .click();
  await expect(body.locator(".test-stamp")).toHaveText("Installed stamp");

  await body.focus();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator("header.bar .save-state")).toHaveText("Saved");
  const stored = await page.evaluate(async (path) => {
    const response = await fetch(`/api${path}`);
    return ((await response.json()) as { page: { body: unknown } }).page.body;
  }, new URL(page.url()).pathname);
  expect(JSON.stringify(stored)).toContain('"type":"test.stamp"');
});
