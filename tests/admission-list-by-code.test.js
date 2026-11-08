/**
 * The administration finds an admission by its code: the list
 * reads the code as the check does - groups, hyphens, lower case - and asks
 * for the identifier it carries; a code that is none, or one signed for
 * another tenant, finds nothing and asks for nothing.
 */

const { expect } = require("chai");
const sinon = require("sinon");

const AdmissionManager = require("../src/commons/data-managers/admission-manager");
const AdmissionController = require("../src/platform/api/controllers/admission-controller");
const {
  codeOf,
  formatCode,
} = require("../src/commons/services/admission/admission-code");
const { Admission } = require("../src/commons/entities/admission/admission");

const TENANT = "tenant-1";
const SECRET = "list-by-code-test-secret-0123456789abcdef";
const KEY = "ABCDEFGHJKLMNPQRSTUV";

function respond() {
  const response = {
    statusCode: null,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
  return response;
}

async function list(query) {
  const response = respond();
  let failure = null;
  await AdmissionController.getAdmissions(
    { params: { tenant: TENANT }, query },
    response,
    (err) => {
      failure = err;
    },
  );
  if (failure) throw failure;
  return response;
}

describe("admission list by code", function () {
  let saved;
  let getAdmissions;

  beforeEach(function () {
    saved = process.env.ADMISSION_CODE_SECRET;
    process.env.ADMISSION_CODE_SECRET = SECRET;
    getAdmissions = sinon
      .stub(AdmissionManager, "getAdmissions")
      .resolves([
        new Admission({ id: "a-1", tenantId: TENANT, key: KEY, usage: [] }),
      ]);
  });

  afterEach(function () {
    sinon.restore();
    if (saved === undefined) delete process.env.ADMISSION_CODE_SECRET;
    else process.env.ADMISSION_CODE_SECRET = saved;
  });

  it("asks for the identifier of a code typed in groups and lower case", async function () {
    const typed = formatCode(codeOf(TENANT, KEY)).toLowerCase();
    const res = await list({ code: typed.replace(" ", "-") });
    expect(res.statusCode).to.equal(200);
    expect(getAdmissions.calledOnce).to.equal(true);
    expect(getAdmissions.firstCall.args[0]).to.equal(TENANT);
    expect(getAdmissions.firstCall.args[1]).to.include({ key: KEY });
    expect(res.body.map((a) => a.id)).to.deep.equal(["a-1"]);
    expect(res.body[0]).not.to.have.property("key");
  });

  it("finds nothing for a forged code, a code of another tenant or no code at all", async function () {
    const forged = `${codeOf(TENANT, KEY).slice(0, -1)}0`;
    for (const code of [
      forged === codeOf(TENANT, KEY) ? `${forged.slice(0, -1)}1` : forged,
      codeOf("tenant-2", KEY),
      "CNQE-SGSD",
    ]) {
      const res = await list({ code });
      expect(res.statusCode).to.equal(200);
      expect(res.body).to.deep.equal([]);
    }
    expect(getAdmissions.called).to.equal(false);
  });

  it("lists without a key where no code is given", async function () {
    await list({ state: "present", code: "  " });
    expect(getAdmissions.firstCall.args[1]).to.include({ state: "present" });
    expect(getAdmissions.firstCall.args[1].key).to.equal(undefined);
  });
});
