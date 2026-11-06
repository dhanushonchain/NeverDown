import { randomUUID } from "node:crypto";

export type FailureIncident = { incidentId: string; spotId: string; reason: string; occurredAt: string };
export type FailureSpot = {
  id: string;
  /** A service-specific health check. Return true only when the dependency is usable. */
  probe?: () => Promise<boolean> | boolean;
  failureThreshold?: number;
  /** Called once per outage. Switch to a preapproved backup here before procurement. */
  onIncident: (event: FailureIncident) => Promise<void> | void;
  /** Receives failures from automatic polling; direct checkNow/reportFailure calls reject normally. */
  onError?: (error: Error) => void;
};

type SpotState = { spot: FailureSpot; failures: number; incidentActive: boolean; checking: boolean };

/** In-process dApp signal and probe adapter. Persisted coordination remains the app's responsibility. */
export class FailureSpotMonitor {
  private readonly spots = new Map<string, SpotState>();
  private timer?: ReturnType<typeof setInterval>;

  register(spot: FailureSpot): void {
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(spot.id)) throw new Error("invalid failure spot id");
    if (this.spots.has(spot.id)) throw new Error("failure spot already registered");
    if (spot.failureThreshold !== undefined && (!Number.isSafeInteger(spot.failureThreshold) || spot.failureThreshold < 1)) throw new Error("failureThreshold must be a positive integer");
    this.spots.set(spot.id, { spot, failures: 0, incidentActive: false, checking: false });
  }

  status(id: string): { consecutiveFailures: number; incidentActive: boolean } {
    const state = this.require(id);
    return { consecutiveFailures: state.failures, incidentActive: state.incidentActive };
  }

  reportHealthy(id: string): void {
    const state = this.require(id);
    state.failures = 0;
    state.incidentActive = false;
  }

  async reportFailure(id: string, reason: string): Promise<FailureIncident | null> {
    const state = this.require(id);
    if (!reason.trim()) throw new Error("failure reason is required");
    state.failures += 1;
    if (state.incidentActive || state.failures < (state.spot.failureThreshold ?? 1)) return null;
    state.incidentActive = true;
    const incident: FailureIncident = { incidentId: `${id}:${randomUUID()}`, spotId: id, reason, occurredAt: new Date().toISOString() };
    await state.spot.onIncident(incident);
    return incident;
  }

  async checkNow(id: string): Promise<void> {
    const state = this.require(id);
    if (!state.spot.probe) throw new Error("failure spot has no probe");
    if (state.checking) return;
    state.checking = true;
    try {
      let healthy = false;
      try { healthy = await state.spot.probe(); } catch { /* A failed probe is an unhealthy signal. */ }
      if (healthy) this.reportHealthy(id);
      else await this.reportFailure(id, "probe failed");
    } finally { state.checking = false; }
  }

  start(intervalMs = 5000): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) throw new Error("intervalMs must be at least 100");
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [id, state] of this.spots) {
        if (state.spot.probe) void this.checkNow(id).catch((error: unknown) => {
          state.spot.onError?.(error instanceof Error ? error : new Error("incident callback failed"));
        });
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private require(id: string): SpotState {
    const state = this.spots.get(id);
    if (!state) throw new Error(`unknown failure spot: ${id}`);
    return state;
  }
}
