const crypto = require("crypto");
const { ServiceUnavailableError } = require("../../../errors/BaseError");

/**
 * The code of an admission (German "Zugangskennung"): the random
 * identifier of the admission followed by its signature, an HMAC-SHA256
 * over tenant and identifier with `ADMISSION_CODE_SECRET`. The identifier
 * cannot be guessed (100 random bits from `crypto.randomBytes`), and a code
 * cannot be made up or altered without the secret: the check verifies the
 * signature before it looks anything up (step 1).
 *
 * The code is unrelated to the booking number and to the public status
 * page of a booking, neither of which admits anybody.
 *
 * Alphabet: digits and upper-case letters without I, O, Y and Z - no
 * letter that reads like a digit, and none that a scanner set to another
 * keyboard layout swaps (Y/Z on a German one). A code is 32 characters,
 * printed in groups of four; spaces, hyphens and lower case are accepted
 * on input, so the manual entry of a damaged code works.
 */

const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWX";
const KEY_LENGTH = 20;
const SIGNATURE_LENGTH = 12;
const CODE_LENGTH = KEY_LENGTH + SIGNATURE_LENGTH;
const MIN_SECRET_LENGTH = 32;

/** The outcome of reading a code. */
const CODE_STATUS = Object.freeze({
  OK: "ok",
  // Not a code of this kind at all: wrong length or characters.
  MALFORMED: "malformed",
  // A code whose signature does not match: altered or made up.
  FORGED: "forged",
});

/**
 * Bytes as characters of the alphabet, five bits each, most significant
 * first.
 *
 * @param {Buffer} bytes
 * @param {number} length The number of characters wanted
 * @returns {string}
 */
function encode(bytes, length) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    if (out.length >= length) {
      break;
    }
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/**
 * The secret of the signatures.
 *
 * @returns {string}
 * @throws {ServiceUnavailableError} `admission_code_secret_missing` without
 *   a secret of at least 32 characters: neither issuance nor check works
 */
function secret() {
  const value = process.env.ADMISSION_CODE_SECRET;
  if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
    throw new ServiceUnavailableError("admission_code_secret_missing");
  }
  return value;
}

/** Whether the secret is configured, for the start-up warning. */
function isConfigured() {
  const value = process.env.ADMISSION_CODE_SECRET;
  return typeof value === "string" && value.length >= MIN_SECRET_LENGTH;
}

/**
 * A new random identifier.
 *
 * @returns {string} 20 characters, 100 bits
 */
function generateKey() {
  // 13 bytes are 104 bits; the first 100 make the identifier.
  return encode(crypto.randomBytes(13), KEY_LENGTH);
}

function signatureOf(tenantId, key) {
  const mac = crypto
    .createHmac("sha256", secret())
    .update(`admission:${tenantId}:${key}`)
    .digest();
  return encode(mac, SIGNATURE_LENGTH);
}

/**
 * The code of an admission, as the ticket carries it.
 *
 * @param {string} tenantId
 * @param {string} key The admission's identifier
 * @returns {string} 32 characters
 */
function codeOf(tenantId, key) {
  return `${key}${signatureOf(tenantId, key)}`;
}

/**
 * The code in groups of four, as the ticket prints it for the manual entry.
 *
 * @param {string} code
 * @returns {string}
 */
function formatCode(code) {
  return code.match(/.{1,4}/g).join(" ");
}

/**
 * The code as entered: without spaces and hyphens, upper case.
 *
 * @param {*} input
 * @returns {string|null} The normalized code, null where it is not text
 */
function normalize(input) {
  if (typeof input !== "string") {
    return null;
  }
  return input.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * Reads a scanned or entered code: is it one, and is it unaltered?
 *
 * @param {string} tenantId The tenant of the check
 * @param {*} input What the scanner or the person sent
 * @returns {{ status: string, key: string|null }} `ok` with the identifier,
 *   `malformed` or `forged` without
 * @throws {ServiceUnavailableError} Without a configured secret
 */
function verifyCode(tenantId, input) {
  const code = normalize(input);
  if (
    !code ||
    code.length !== CODE_LENGTH ||
    ![...code].every((char) => ALPHABET.includes(char))
  ) {
    return { status: CODE_STATUS.MALFORMED, key: null };
  }
  const key = code.slice(0, KEY_LENGTH);
  const given = Buffer.from(code.slice(KEY_LENGTH));
  const expected = Buffer.from(signatureOf(tenantId, key));
  if (!crypto.timingSafeEqual(given, expected)) {
    return { status: CODE_STATUS.FORGED, key: null };
  }
  return { status: CODE_STATUS.OK, key };
}

module.exports = {
  CODE_STATUS,
  CODE_LENGTH,
  ALPHABET,
  generateKey,
  codeOf,
  formatCode,
  verifyCode,
  isConfigured,
};
