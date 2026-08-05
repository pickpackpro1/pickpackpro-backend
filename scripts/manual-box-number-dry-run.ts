import assert from "node:assert/strict";
import { ApiError } from "../lib/apiResponse";
import {
  boxNumberResponseFields,
  displayBoxTitle,
  existingBoxNumberMatches,
  manualBoxNumberFromBody,
  normalizeBoxSize,
  normalizeBoxType,
} from "../lib/boxNumbers";

const manual = manualBoxNumberFromBody({ boxNumber: "  A-01  " });
assert.equal(manual, "A-01");
assert.equal(normalizeBoxType("Box"), "box");
assert.equal(normalizeBoxSize("Medium"), "medium");

assert.throws(
  () => manualBoxNumberFromBody({ box_number: "   " }),
  (error) => error instanceof ApiError && error.message === "Box number cannot be empty.",
);

const autoBox = { box_number: 1, manual_box_number: null, box_type: "box" };
const manualBox = { box_number: 2, manual_box_number: "FBA-BOX-5", box_type: "box" };

assert.equal(existingBoxNumberMatches("1", autoBox), true);
assert.equal(existingBoxNumberMatches("Box 1", autoBox), true);
assert.equal(existingBoxNumberMatches("fba-box-5", manualBox), true);
assert.deepEqual(boxNumberResponseFields(manualBox), {
  boxNumber: "FBA-BOX-5",
  box_number: "FBA-BOX-5",
  manualBoxNumber: "FBA-BOX-5",
  manual_box_number: "FBA-BOX-5",
  boxSequenceNumber: 2,
  box_sequence_number: 2,
});
assert.equal(displayBoxTitle(autoBox), "Box 1");
assert.equal(displayBoxTitle(manualBox), "FBA-BOX-5");

console.log(JSON.stringify({ ok: true, manualBoxNumber: manual }, null, 2));
