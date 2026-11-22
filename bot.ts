import { draw, log, run, type Hello, type Observation } from "./mechfight.ts"
import { Brain } from "./brain.ts"

run((hello: Hello) => {
  const t0 = performance.now()
  const brain = new Brain(hello)
  const n = brain.world ? Brain.warmup(hello, brain.world, 1500) : 0
  log(`init ${(performance.now() - t0).toFixed(0)} ms, world ${brain.world ? "ok" : "missing"}, warmup ${n}`)
  return {
    name: "buckeye-survivor",
    act(obs: Observation) {
      const t1 = performance.now()
      const a = brain.act(obs)
      const dt = performance.now() - t1
      if (dt > 25) log(`slow decision t=${obs.t} ${dt.toFixed(1)} ms mode=${brain.mode}`)
      draw.label(brain.label)
      return a
    },
  }
})
