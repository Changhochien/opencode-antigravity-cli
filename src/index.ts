import { Plugin } from '@opencode/plugin'
import { Jobs, discoverModels, executable, publicJob } from './jobs.js'
import { registerTools } from './tools.js'
import { setupProvider } from './provider.js'

export default Plugin.define({
  id: 'antigravity',
  async setup(ctx) {
    const binary = typeof ctx.options.binary === 'string' ? ctx.options.binary : undefined
    const jobs = new Jobs(undefined, { binary: () => executable(binary) })
    await registerTools(ctx, jobs)
    // Unloading closes the provider endpoint, not the detached job supervisors.
    return setupProvider(ctx, {
      models: () => discoverModels(binary),
      latest: sessionID => jobs.latest(sessionID),
      claimUsage: (sessionID, jobID) => jobs.claimUsage(sessionID, jobID),
      observe: (sessionID, jobID, seconds, signal) => jobs.observe(sessionID, jobID, seconds, signal),
      async auxiliary(prompt, model, sessionID, directory, signal) {
        const job = await jobs.start({ prompt, model, session_id: sessionID, directory, kind: 'auxiliary' })
        return publicJob(await jobs.wait(sessionID, job.job_id, 120, signal))
      },
    })
  },
})
