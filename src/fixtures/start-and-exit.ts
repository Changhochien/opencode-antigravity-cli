import { Jobs } from '../jobs'
const [root, directory, fake] = process.argv.slice(2)
const jobs = new Jobs(root, { binary: async () => process.execPath, prefix: [fake], node: 'node' })
const job = await jobs.start({ session_id: 'session-a', directory, prompt: JSON.stringify({ delay: 400 }) })
console.log(job.job_id)
process.exit(0)
