import { draw, log, run, type Hello, type Observation } from "./mechfight.ts"
import { Brain } from "./brain.ts"

run((hello: Hello) => {
  const t0 = performance.now()
  const brain = new Brain(hello)
  log(`init ${(performance.now() - t0).toFixed(0)} ms, world ${brain.world ? "ok" : "missing"}`)
  return {
    name: "buckeye-survivor",
    act(obs: Observation) {
      const a = brain.act(obs)
      draw.label(brain.label)
      return a
    },
  }
})
