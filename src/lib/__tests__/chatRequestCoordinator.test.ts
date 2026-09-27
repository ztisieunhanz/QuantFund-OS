import { describe, expect, it } from "vitest";
import { createChatRequestCoordinator } from "../chatRequestCoordinator";

describe("P16-D chat request coordination", () => {
  it("lets the latest overlapping request supersede and abort the prior lease", () => {
    const coordinator = createChatRequestCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    expect(first.requestId).toBe(1);
    expect(first.signal.aborted).toBe(true);
    expect(second.requestId).toBe(2);
    expect(second.signal.aborted).toBe(false);
    expect(coordinator.isPending()).toBe(true);
    expect(coordinator.isCurrent(first.requestId)).toBe(false);
    expect(coordinator.isCurrent(second.requestId)).toBe(true);
  });

  it("does not let stale success or error publish over the latest request", () => {
    const coordinator = createChatRequestCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();
    const published: string[] = [];

    if (coordinator.isCurrent(first.requestId)) published.push("stale success");
    if (coordinator.isCurrent(first.requestId)) published.push("stale error");
    if (coordinator.isCurrent(second.requestId)) published.push("latest success");

    expect(published).toEqual(["latest success"]);
  });

  it("does not let a stale finally clear loading for the latest request", () => {
    const coordinator = createChatRequestCoordinator();
    const first = coordinator.begin();
    const second = coordinator.begin();

    coordinator.finish(first.requestId);
    expect(coordinator.isCurrent(second.requestId)).toBe(true);
    expect(coordinator.isPending()).toBe(true);

    coordinator.finish(second.requestId);
    expect(coordinator.isPending()).toBe(false);
  });

  it("invalidates and aborts the active request when its consumer is disposed", () => {
    const coordinator = createChatRequestCoordinator();
    const active = coordinator.begin();

    coordinator.dispose();

    expect(active.signal.aborted).toBe(true);
    expect(coordinator.isCurrent(active.requestId)).toBe(false);
    expect(coordinator.isPending()).toBe(false);
  });
});
