const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("desktop shell keeps renderer isolation controls enabled", () => {
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /setWindowOpenHandler/);
});

test("页面从服务器加载后，本机能力只给自己服务器的页面（D-83）", () => {
  const handlers = source.match(/ipcMain\.handle\("[^"]+",[^\n]*\n[^\n]*/g) ?? [];
  assert.ok(handlers.length >= 5);
  for (const handler of handlers) assert.match(handler, /isTrustedSender\(event\)/, handler);
});

test("只能在服务器和本地状态页之间跳转，权限只给服务器", () => {
  assert.match(source, /will-navigate[\s\S]{0,200}isServerUrl\(url\)/);
  assert.match(source, /will-redirect[\s\S]{0,120}isServerUrl\(url\)/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /CecsDesktop\//);
});
