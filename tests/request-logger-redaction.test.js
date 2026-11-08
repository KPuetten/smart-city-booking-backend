/**
 * The request log of development names no credential: neither a password
 * or token in the body nor an admission's code, which admits whoever holds
 * it - in the body of a check or in the query of the administration's
 * search (`?code=`). Everything else is logged as before.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const bunyan = require("bunyan");

const { requestLogger } = require("../src/middleware/logger");

const CODE = "7Q4M-2KXH-9JTV-W3NB-5R8C-PD6F-AG1E-UL0S";

describe("request log: credentials", function () {
  let lines;
  let saved;

  beforeEach(function () {
    lines = [];
    sinon.stub(bunyan.prototype, "info").callsFake((...args) => {
      lines.push(JSON.stringify(args));
    });
    saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
  });

  afterEach(function () {
    sinon.restore();
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  });

  function log(req) {
    let called = false;
    requestLogger(
      {
        baseUrl: "",
        params: {},
        headers: {},
        ip: "127.0.0.1",
        query: {},
        ...req,
      },
      {},
      () => (called = true),
    );
    expect(called).to.equal(true);
    expect(lines).to.have.length(1);
    return JSON.parse(lines[0])[0];
  }

  it("names no admission code of a check's body, nor a password or token", function () {
    const url = "/api/tenant-1/admission/check";
    const logged = log({
      method: "POST",
      url,
      originalUrl: url,
      path: url,
      body: {
        code: CODE,
        requestId: "scan-0001",
        password: "geheim",
        token: "t0k3n",
      },
    });

    expect(lines[0]).to.not.include(CODE);
    expect(logged.body).to.deep.equal({
      code: "[REDACTED]",
      requestId: "scan-0001",
      password: "[REDACTED]",
      token: "[REDACTED]",
    });
  });

  it("names no admission code of the search's query, the other fields as they are", function () {
    const url = `/api/tenant-1/admission/admissions?facilityId=freibad&code=${CODE}&limit=20`;
    const logged = log({
      method: "GET",
      url,
      originalUrl: url,
      path: "/api/tenant-1/admission/admissions",
      query: { facilityId: "freibad", code: CODE, limit: "20" },
    });

    expect(lines[0]).to.not.include(CODE);
    expect(logged.query).to.deep.equal({
      facilityId: "freibad",
      code: "[REDACTED]",
      limit: "20",
    });
    const shown =
      "/api/tenant-1/admission/admissions?facilityId=freibad&code=[REDACTED]&limit=20";
    expect(logged.url).to.equal(shown);
    expect(logged.originalUrl).to.equal(shown);
    expect(JSON.parse(lines[0])[1]).to.equal(`GET ${shown}`);
  });

  it("leaves a request without a credential as it was", function () {
    const url = "/api/tenant-1/bookables?type=ticket&promocode=SOMMER";
    const logged = log({
      method: "GET",
      url,
      originalUrl: url,
      path: "/api/tenant-1/bookables",
      query: { type: "ticket", promocode: "SOMMER" },
    });

    expect(logged.url).to.equal(url);
    expect(logged.query).to.deep.equal({ type: "ticket", promocode: "SOMMER" });
  });
});
