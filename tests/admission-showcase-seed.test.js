const { expect } = require("chai");

const {
  CODE_STATUS,
  codeOf,
  formatCode,
  generateKey,
  verifyCode,
} = require("../src/commons/services/admission/admission-code");
const { GUESTS, history, typo } = require("../scripts/seed-admission-showcase");

const SECRET = "test-admission-secret-0123456789abcdef";

/**
 * The showcase seed (scripts/seed-admission-showcase.js) writes its history
 * through the services; what it can get wrong without a database is the
 * plan itself: whom it scans, in which order, and the forged code.
 */
describe("seed-admission-showcase", function () {
  let saved;

  beforeEach(function () {
    saved = process.env.ADMISSION_CODE_SECRET;
    process.env.ADMISSION_CODE_SECRET = SECRET;
  });

  afterEach(function () {
    if (saved === undefined) {
      delete process.env.ADMISSION_CODE_SECRET;
    } else {
      process.env.ADMISSION_CODE_SECRET = saved;
    }
  });

  it("scans only the admissions it buys, and resets at 03:00 on both days", function () {
    const refs = new Set(GUESTS.map((guest) => guest.ref));
    const events = history();
    for (const event of events.filter((e) => e.kind !== "reset")) {
      const [ref] = event.who.split(":");
      expect(event.who === "forged" || refs.has(ref), event.who).to.equal(true);
    }
    const resets = events.filter((e) => e.kind === "reset");
    expect(resets.map((e) => [e.d, e.time])).to.deep.equal([
      [-1, "03:00"],
      [0, "03:00"],
    ]);
  });

  it("lets nobody leave who has not entered, in the order it runs them", function () {
    const order = history().sort(
      (a, b) => a.d - b.d || a.time.localeCompare(b.time),
    );
    const inside = new Set();
    for (const event of order) {
      if (event.kind === "reset") {
        // The daily reset checks out who is left.
        inside.clear();
      } else if (event.kind === "scan" && event.direction === "exit") {
        expect(inside.has(event.who), `${event.who} ${event.time}`).to.equal(
          true,
        );
        inside.delete(event.who);
      } else if (event.kind === "scan") {
        inside.add(event.who);
      }
    }
    // Every event runs by the default end of the showcase, 10:15.
    const last = order.filter((e) => e.d === 0).pop();
    expect(last.time <= "10:15").to.equal(true);
  });

  it("forges a code by one character, refused at step 1", function () {
    const code = formatCode(codeOf("t1", generateKey()));
    const forged = typo(code);
    const differing = [...code].filter((c, i) => c !== forged[i]);
    expect(differing).to.have.length(1);
    expect(verifyCode("t1", code).status).to.equal(CODE_STATUS.OK);
    expect(verifyCode("t1", forged).status).to.equal(CODE_STATUS.FORGED);
  });
});
