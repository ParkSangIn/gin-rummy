import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const registry = process.env.USERPROFILE
  ? join(process.env.USERPROFILE, ".cargo", "registry", "src", "index.crates.io-1949cf8c6b5b557f")
  : "";
const engineDriver = join(registry, "gin-rummy-engine-0.3.0", "src", "driver.rs");
const roundSource = join(registry, "gin-rummy-0.1.3", "src", "round.rs");

for (const file of [engineDriver, roundSource]) {
  if (!existsSync(file)) throw new Error(`Missing downloaded crate source: ${file}`);
}

const driver = readFileSync(engineDriver, "utf8");
const round = readFileSync(roundSource, "utf8");
const checks = [
  [driver, "DealerRotation::WinnerDeals", "winner deals next"],
  [driver, "DrawAction::Stock", "driver applies forced stock"],
  [round, "self.turn = self.non_dealer()", "non-dealer resumes after double pass"],
  [round, "self.forced_stock = true", "double pass forces stock"],
  [round, "RoundError::MustDrawFromStock", "forced draw rejects discard"],
  [round, "taken_discard: Option<Card>", "taken discard is tracked"],
];

for (const [source, expected, label] of checks) {
  if (!source.includes(expected)) throw new Error(`Engine contract mismatch: ${label}`);
}

console.log(`Verified ${checks.length} gin-rummy-engine rule-contract checks.`);
