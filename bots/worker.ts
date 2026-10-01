import { parentPort, workerData } from "node:worker_threads";
import { runBot, type FleetConfig } from "./fleet";

const { fleet, indices } = workerData as { fleet: FleetConfig; indices: number[] };

await Promise.all(indices.map((index) => runBot(fleet, index)));
parentPort?.close();
