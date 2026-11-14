/** Where the application reads the current time, so tests can control it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
