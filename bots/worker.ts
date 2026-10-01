import { parentPort, workerData } from "node:worker_threads";
import { runBot, type FleetConfig } from "./fleet";
import { Landmarks } from "./memory";

const { fleet, indices } = workerData as { fleet: FleetConfig; indices: number[] };

const landmarks = new Landmarks(fleet.memory);
await Promise.all(indices.map((index) => runBot(fleet, index, landmarks)));
landmarks.close();
parentPort?.close();
