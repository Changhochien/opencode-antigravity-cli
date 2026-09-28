import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { parseModels, runProcess, executable } from "../src/runtime.js"

const fixture = fileURLToPath(new URL("./fixtures/cli.mjs", import.meta.url))

test("parses model inventories and ignores progress text", () => {
  expect(parseModels("Fetching available models...\nmodel-high\tModel (High)\nmodel-low  Model (Low)\nmodel-high\tModel (High)\n")).toEqual([
    { id: "model-high", name: "Model (High)" }, { id: "model-low", name: "Model (Low)" },
  ])
  expect(() => parseModels("authentication required")).toThrow("no model inventory")
})

test("respects an explicit executable path", async () => {
  expect(await executable(process.execPath)).toBe(process.execPath)
})

test("preserves prompt arguments literally and uses the supplied directory", async () => {
  const prompt = "quotes ' \" ; $(echo not-a-shell)"
  const result = await runProcess(process.execPath, [fixture, "success", prompt], process.cwd(), 30, new AbortController().signal)
  expect(result.result.status).toBe("SUCCESS")
  expect(JSON.parse(result.result.response!)).toEqual({ args: [prompt], cwd: process.cwd() })
})

test("rejects CLI error envelopes even with exit code zero", async () => {
  await expect(runProcess(process.execPath, [fixture, "failure"], process.cwd(), 30, new AbortController().signal)).rejects.toThrow("simulated failure")
})

test("reports startup output without a JSON envelope", async () => {
  await expect(runProcess(process.execPath, [fixture, "invalid"], process.cwd(), 30, new AbortController().signal)).rejects.toThrow("no valid JSON")
})

test("cancels a running subprocess", async () => {
  await expect(runProcess(process.execPath, [fixture, "wait"], process.cwd(), 30, AbortSignal.timeout(150))).rejects.toThrow("canceled")
})
