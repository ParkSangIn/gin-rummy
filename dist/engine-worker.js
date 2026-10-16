// The Monte Carlo engine runs away from the page's main thread.  A slow
// decision therefore leaves the board responsive and visibly thinking.
let engine;

async function initialize() {
  if (engine) return;
  engine = await import("./engine/gin_engine.js");
  await engine.default();
}

self.onmessage = async ({ data }) => {
  const { id, method, argument } = data;
  try {
    await initialize();
    let result;
    if (method === "init") result = "ready";
    else if (method === "start_game") result = engine.start_game();
    else if (method === "next_hand") result = engine.next_hand();
    else if (method === "submit_action") result = engine.submit_action(argument);
    else if (method === "assess_recorded_upcard") result = engine.assess_recorded_upcard(argument);
    else throw new Error(`unknown engine method: ${method}`);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
};
