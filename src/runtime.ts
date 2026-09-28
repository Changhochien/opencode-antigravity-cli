import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

export type Usage = Record<string, number>
export type AgyResult = {
  conversation_id?: string
  status: string
  response?: string
  error?: string
  duration_seconds?: number
  usage?: Usage
  turn_usage?: Usage
}
export type CatalogModel = { id: string; name: string }
export type Runtime = {
  models(): Promise<CatalogModel[]>
  run(args: string[], cwd: string, timeout: number, signal: AbortSignal): Promise<{ result: AgyResult; diagnostics: string }>
}

export async function executable(override?: string): Promise<string> {
  if (override?.trim()) return override
  if (process.env.AGY_BIN?.trim()) return process.env.AGY_BIN
  // Desktop apps may not inherit the interactive shell's PATH.
  const local = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "agy", "bin", "agy.exe")
    : join(homedir(), ".local", "bin", "agy")
  try {
    await access(local, constants.X_OK)
    return local
  } catch {
    return process.platform === "win32" ? "agy.exe" : "agy"
  }
}

export function parseModels(output: string): CatalogModel[] {
  const models = output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([a-z0-9][a-z0-9._-]*)(?:\t| {2,})(.+)$/i)
    return match ? [{ id: match[1], name: match[2].trim() }] : []
  })
  if (!models.length) throw new Error("agy models returned no model inventory. Run agy interactively and sign in first.")
  return [...new Map(models.map((model) => [model.id, model])).values()]
}

export async function runProcess(binary: string, args: string[], cwd: string, timeout: number, signal: AbortSignal) {
  signal.throwIfAborted()
  return new Promise<{ result: AgyResult; diagnostics: string }>((resolve, reject) => {
    const child = execFile(binary, args, {
      cwd, encoding: "utf8", signal,
      timeout: (timeout + 10) * 1000,
      killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (signal.aborted) {
        reject(new Error("Antigravity run canceled."))
        return
      }
      let result: AgyResult | undefined
      try {
        const parsed = JSON.parse(stdout)
        if (parsed && typeof parsed.status === "string") result = parsed
      } catch {
        // Startup/authentication failures may not produce JSON.
      }
      const diagnostics = stderr.trim().slice(-12000)
      if (error || !result || result.status !== "SUCCESS") {
        const reason = result?.error || (error?.killed ? "Process stopped after its time/output limit." : error?.message)
          || (result ? `AGY finished with status ${result.status}.` : "AGY returned no valid JSON result.")
        reject(new Error([
          `Antigravity failed: ${reason}`,
          result?.conversation_id ? `Conversation ID: ${result.conversation_id}` : "",
          result?.response || "", diagnostics,
        ].filter(Boolean).join("\n")))
        return
      }
      resolve({ result, diagnostics })
    })
    child.stdin?.end()
  })
}

export function createRuntime(binary?: string): Runtime {
  return {
    async models() {
      const { stdout } = await promisify(execFile)(await executable(binary), ["models"], {
        encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024,
      })
      return parseModels(stdout)
    },
    async run(args, cwd, timeout, signal) {
      return runProcess(await executable(binary), args, cwd, timeout, signal)
    },
  }
}
