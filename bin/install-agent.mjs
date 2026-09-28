#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log("Usage: opencode-antigravity-agent [--project]\nInstalls the antigravity agent globally, or in the current project's .opencode directory. Existing files are preserved.")
} else if (args.some((arg) => arg !== "--project")) {
  console.error("Unknown option. Use --help.")
  process.exitCode = 1
} else {
  const config = args.includes("--project")
    ? resolve(".opencode")
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  const target = join(config, "agents", "antigravity.md")
  try {
    const template = await readFile(new URL("../agents/antigravity.md", import.meta.url), "utf8")
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, template, { flag: "wx" })
    console.log(`Installed ${target}`)
    console.log("Choose antigravity in the agent picker, then an Antigravity CLI model in the model picker.")
  } catch (error) {
    if (error?.code === "EEXIST") {
      console.log(`Keeping existing agent: ${target}`)
    } else {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
