import { readFileSync } from "node:fs";

const DEFAULT_DELAYS_MS = [50, 150, 300];
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function isTemporaryReadError(error) {
  return error?.code === "EAGAIN" || error?.errno === -11;
}

function sleepSync(milliseconds) {
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

export function readFileSyncWithRetry(
  file,
  options,
  { read = readFileSync, sleep = sleepSync, delays = DEFAULT_DELAYS_MS } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return read(file, options);
    } catch (error) {
      if (!isTemporaryReadError(error) || attempt >= delays.length) throw error;
      sleep(delays[attempt]);
    }
  }
}
