const { expect } = require("chai");

const {
  CODE_STATUS,
  CODE_LENGTH,
  ALPHABET,
  generateKey,
  codeOf,
  formatCode,
  verifyCode,
} = require("../src/commons/services/admission/admission-code");

const SECRET = "test-admission-secret-0123456789abcdef";

describe("admission code: random identifier plus HMAC signature", function () {
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

  it("makes identifiers of 20 characters of the alphabet, all different", function () {
    const keys = new Set();
    for (let i = 0; i < 500; i++) {
      const key = generateKey();
      expect(key).to.have.length(20);
      expect([...key].every((c) => ALPHABET.includes(c))).to.equal(true);
      keys.add(key);
    }
    expect(keys.size).to.equal(500);
  });

  it("uses no I, O, Y or Z: nothing that reads like a digit or a keyboard layout swaps", function () {
    for (const letter of ["I", "O", "Y", "Z"]) {
      expect(ALPHABET).not.to.include(letter);
    }
    expect(ALPHABET).to.have.length(32);
  });

  it("verifies its own code and answers the identifier", function () {
    const key = generateKey();
    const code = codeOf("tenant-1", key);
    expect(code).to.have.length(CODE_LENGTH);
    expect(verifyCode("tenant-1", code)).to.deep.equal({
      status: CODE_STATUS.OK,
      key,
    });
  });

  it("accepts the printed form: groups, hyphens, lower case", function () {
    const key = generateKey();
    const code = codeOf("tenant-1", key);
    expect(verifyCode("tenant-1", formatCode(code)).key).to.equal(key);
    expect(
      verifyCode("tenant-1", formatCode(code).replace(/ /g, "-")).key,
    ).to.equal(key);
    expect(verifyCode("tenant-1", code.toLowerCase()).key).to.equal(key);
  });

  it("refuses a code with one character changed in the identifier as forged", function () {
    const code = codeOf("tenant-1", generateKey());
    const swapped = code[0] === "A" ? "B" : "A";
    expect(verifyCode("tenant-1", swapped + code.slice(1))).to.deep.equal({
      status: CODE_STATUS.FORGED,
      key: null,
    });
  });

  it("refuses a code with one character changed in the signature as forged", function () {
    const code = codeOf("tenant-1", generateKey());
    const last = code[code.length - 1] === "A" ? "B" : "A";
    expect(verifyCode("tenant-1", code.slice(0, -1) + last).status).to.equal(
      CODE_STATUS.FORGED,
    );
  });

  it("refuses the code of another tenant: the signature binds the tenant", function () {
    const code = codeOf("tenant-1", generateKey());
    expect(verifyCode("tenant-2", code).status).to.equal(CODE_STATUS.FORGED);
  });

  it("refuses a code signed with another secret", function () {
    const code = codeOf("tenant-1", generateKey());
    process.env.ADMISSION_CODE_SECRET = "another-secret-0123456789abcdefghij";
    expect(verifyCode("tenant-1", code).status).to.equal(CODE_STATUS.FORGED);
  });

  it("calls anything that is no code malformed: a booking number, a URL, nothing", function () {
    for (const input of [
      "AB12CD34",
      "https://example.org/status/1",
      "",
      null,
      42,
    ]) {
      expect(verifyCode("tenant-1", input).status).to.equal(
        CODE_STATUS.MALFORMED,
      );
    }
  });

  it("refuses to sign or verify without a secret of 32 characters", function () {
    process.env.ADMISSION_CODE_SECRET = "short";
    expect(() => codeOf("tenant-1", generateKey())).to.throw(
      "admission_code_secret_missing",
    );
    delete process.env.ADMISSION_CODE_SECRET;
    expect(() => verifyCode("tenant-1", "0".repeat(CODE_LENGTH))).to.throw(
      "admission_code_secret_missing",
    );
  });
});
