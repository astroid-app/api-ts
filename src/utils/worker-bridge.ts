import { parentPort, isMainThread } from "worker_threads";
import { health } from "./health";

// When imported from worker context, forward simple logs to health tracker
if (!isMainThread && parentPort) {
  health.record("worker", "Queue worker started");
  try {
    parentPort.on("message", (msg) => {
      health.record("worker-msg", "Message from worker", msg);
    });
  } catch {
    // ignore
  }
}

export {}; // module side-effects only
