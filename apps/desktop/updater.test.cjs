const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions } = require("./updater.cjs");

test("compareVersions 按 x.y.z 比大小，决定要不要强制更新", () => {
  assert.equal(compareVersions("0.1.0", "0.1.1"), -1);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), 0);
});
