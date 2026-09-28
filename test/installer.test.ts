import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

test("installs a portable agent and preserves an existing definition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-agent-test-"))
  const installer = fileURLToPath(new URL("../bin/install-agent.mjs", import.meta.url))
  try {
    await promisify(execFile)(process.execPath, [installer, "--project"], { cwd: directory })
    const target = join(directory, ".opencode", "agents", "antigravity.md")
    const content = await readFile(target, "utf8")
    expect(content).toContain("mode: all")
    expect(content).not.toContain("\nmodel:")
    await writeFile(target, "user-customized-agent")
    const rerun = await promisify(execFile)(process.execPath, [installer, "--project"], { cwd: directory })
    expect(rerun.stdout).toContain("Keeping existing agent")
    expect(await readFile(target, "utf8")).toBe("user-customized-agent")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
