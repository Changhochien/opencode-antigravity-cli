import { rm } from 'node:fs/promises'

// A supervisor publishes completion just before its process releases its cwd.
// Windows cannot remove that directory until the final handles close. Bun's
// fs.rm does not consistently honor Node's maxRetries option for EBUSY.
export async function cleanup(directory: string) {
  for (let attempt = 0; ; attempt++) {
    try { await rm(directory, { recursive: true, force: true }); return }
    catch (error: any) {
      if (attempt >= 100 || !['EBUSY', 'EACCES', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}
