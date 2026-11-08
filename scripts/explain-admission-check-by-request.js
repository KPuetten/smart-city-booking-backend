#!/usr/bin/env node
/**
 * Shows the query plan of the look-up of a scan sent again
 * (`AdmissionCheckManager.getCheckByRequest`) against the database of
 * `.env` (`DB_URL`, `DB_NAME`): the filter as the manager builds it, and
 * for comparison the plain equality on the request id it used before.
 * The first is meant to be an IXSCAN of the partial index
 * `tenantId_1_deviceId_1_userId_1_requestId_1`; the second cannot use that
 * index.
 *
 * Read only: `explain` with the native driver, no Mongoose model compiled,
 * so no index is built and nothing is written. Takes a stored check with a
 * request id as its example, or the ids given:
 *
 *   node scripts/explain-admission-check-by-request.js \
 *     [--tenant=<id> --device=<id> --request=<id>]
 *
 * Exits with 1 when the manager's filter is not answered by an IXSCAN of
 * that index.
 */

require("dotenv").config();
const { MongoClient } = require("mongodb");
const AdmissionCheckManager = require("../src/commons/data-managers/admission-check-manager");

const INDEX = "tenantId_1_deviceId_1_userId_1_requestId_1";

function argument(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

/** The stages of a winning plan, outermost first. */
function stagesOf(plan) {
  const stages = [];
  for (let stage = plan; stage; stage = stage.inputStage) {
    stages.push(
      stage.indexName ? `${stage.stage}(${stage.indexName})` : stage.stage,
    );
  }
  return stages;
}

async function explain(collection, filter) {
  const result = await collection
    .find(filter)
    .limit(1)
    .explain("executionStats");
  return {
    stages: stagesOf(result.queryPlanner.winningPlan),
    keysExamined: result.executionStats.totalKeysExamined,
    docsExamined: result.executionStats.totalDocsExamined,
    ms: result.executionStats.executionTimeMillis,
  };
}

async function main() {
  if (!process.env.DB_URL) {
    throw new Error("DB_URL is not set (.env)");
  }
  const client = await MongoClient.connect(process.env.DB_URL);
  try {
    const collection = client
      .db(process.env.DB_NAME)
      .collection("admissionchecks");

    const indexes = await collection.indexes();
    const index = indexes.find((i) => i.name === INDEX);
    console.log(
      `${INDEX}: ${index ? JSON.stringify(index.partialFilterExpression) : "missing"}`,
    );

    let tenantId = argument("tenant");
    let deviceId = argument("device");
    let requestId = argument("request");
    let userId = null;
    if (!tenantId || !requestId) {
      const example = await collection.findOne(
        { requestId: { $type: "string" } },
        { projection: { tenantId: 1, deviceId: 1, userId: 1, requestId: 1 } },
      );
      if (!example) {
        throw new Error("no stored check with a request id; pass the ids");
      }
      ({ tenantId, deviceId, userId, requestId } = example);
    }
    const actor = { deviceId, userId };
    console.log(
      `documents: ${await collection.estimatedDocumentCount()}, example: tenant ${tenantId}, device ${deviceId}, request ${requestId}`,
    );

    const fixed = AdmissionCheckManager.requestFilter(
      tenantId,
      actor,
      requestId,
    );
    const before = { ...fixed, requestId };
    const now = await explain(collection, fixed);
    const was = await explain(collection, before);
    console.log("manager filter:", JSON.stringify(fixed));
    console.log("  plan:", now.stages.join(" <- "), now);
    console.log("plain equality (before):", JSON.stringify(before));
    console.log("  plan:", was.stages.join(" <- "), was);

    if (!now.stages.includes(`IXSCAN(${INDEX})`)) {
      console.error(`FAIL: the manager's filter is not an IXSCAN of ${INDEX}`);
      process.exitCode = 1;
    } else {
      console.log(`OK: IXSCAN of ${INDEX}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
