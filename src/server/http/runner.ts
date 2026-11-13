import { Refusal } from "../errors.js";
import type { Failure } from "../commands/query.js";

export type VoyageRunner = {
  start(
    taskId: string,
    run: (o: { signal: AbortSignal; onLaunched: (voyageId: string) => void }) => Promise<unknown>,
  ): Promise<{ launched: true; voyageId: string } | { launched: false; result: unknown }>;
  cancel(voyageId: string): void;
  abortAll(): Promise<void>;
  failures(): Failure[];
  inFlight(): number;
};

type Flight = { controller: AbortController; settled: Promise<void> };

export function createVoyageRunner(opts: { onFailure: () => void }): VoyageRunner {
  const flights = new Map<string, Flight>();
  const recorded: Failure[] = [];
  let shuttingDown = false;

  return {
    start(taskId, run) {
      if (shuttingDown) return Promise.reject(new Refusal("the server is shutting down"));
      const controller = new AbortController();
      let voyageId: string | undefined;
      let answerResolve!: (answer: { launched: true; voyageId: string } | { launched: false; result: unknown }) => void;
      let answerReject!: (error: unknown) => void;
      const answer = new Promise<{ launched: true; voyageId: string } | { launched: false; result: unknown }>((resolve, reject) => {
        answerResolve = resolve;
        answerReject = reject;
      });
      const running = Promise.resolve().then(() => run({
        signal: controller.signal,
        onLaunched(id) {
          if (voyageId !== undefined) return;
          voyageId = id;
          answerResolve({ launched: true, voyageId: id });
        },
      }));
      const settled = running.then(
        (result) => {
          if (voyageId === undefined) answerResolve({ launched: false, result });
        },
        (error: unknown) => {
          if (voyageId === undefined) {
            answerReject(error);
            return;
          }
          const failure: Failure = {
            ts: new Date().toISOString(), taskId, voyageId,
            message: error instanceof Error ? error.message : String(error),
          };
          recorded.unshift(failure);
          if (recorded.length > 50) recorded.length = 50;
          console.error(`[voyage ${voyageId}] ${failure.message.replace(/[\r\n]+/g, " ")}`);
          try { opts.onFailure(); } catch { /* a notification cannot fail the runner */ }
        },
      ).finally(() => {
        if (voyageId !== undefined) flights.delete(voyageId);
      });
      const originalResolve = answerResolve;
      answerResolve = (value) => {
        if (value.launched) flights.set(value.voyageId, { controller, settled });
        originalResolve(value);
      };
      return answer;
    },
    cancel(voyageId) {
      const flight = flights.get(voyageId);
      if (!flight) throw new Refusal(`voyage ${voyageId} is not running in this server`);
      flight.controller.abort();
    },
    async abortAll() {
      shuttingDown = true;
      const current = [...flights.values()];
      for (const flight of current) flight.controller.abort();
      await Promise.all(current.map((flight) => flight.settled));
    },
    failures: () => recorded.slice(),
    inFlight: () => flights.size,
  };
}
