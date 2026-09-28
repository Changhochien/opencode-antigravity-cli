const mode = process.argv[2]
if (mode === "invalid") {
  console.log("authentication required")
} else if (mode === "failure") {
  console.error("simulated diagnostic")
  console.log(JSON.stringify({ status: "ERROR", error: "simulated failure", conversation_id: "fixture-conversation" }))
} else if (mode === "wait") {
  setTimeout(() => console.log("finished"), 10000)
} else {
  console.log(JSON.stringify({
    status: "SUCCESS", conversation_id: "fixture-conversation",
    response: JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd() }),
  }))
}
