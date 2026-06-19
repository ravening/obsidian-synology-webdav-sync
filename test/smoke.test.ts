import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { advanceTime, useFakeClock } from "./setup";

/**
 * Smoke tests that verify the test toolchain itself is wired up correctly:
 * the runner executes, fast-check runs property checks, the jsdom environment
 * exposes `DOMParser`, and the fake-clock helpers advance time deterministically.
 */
describe("test toolchain smoke checks", () => {
  it("runs a basic assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("runs fast-check property checks", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
    );
  });

  it("exposes DOMParser from the jsdom environment", () => {
    const doc = new DOMParser().parseFromString(
      "<root><child>ok</child></root>",
      "application/xml",
    );
    expect(doc.querySelector("child")?.textContent).toBe("ok");
  });

  it("advances time with the fake clock helper", async () => {
    useFakeClock();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 30_000);

    expect(fired).toBe(false);
    await advanceTime(30_000);
    expect(fired).toBe(true);
  });
});
