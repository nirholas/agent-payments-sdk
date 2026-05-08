// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

export class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.running < this.max) {
      this.running++;
      return this.release.bind(this);
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve(this.release.bind(this));
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  get inFlight(): number {
    return this.running;
  }
}
