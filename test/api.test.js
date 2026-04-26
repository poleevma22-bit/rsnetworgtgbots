import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../src/server.js";

function listen() {
  return new Promise((resolve) => {
    const instance = server.listen(0, () => resolve(instance));
  });
}

test("api rejects account with unsafe policy", async () => {
  const instance = await listen();
  const { port } = instance.address();

  const response = await fetch(`http://localhost:${port}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Unsafe",
      handle: "@unsafe",
      replyDelaySeconds: 0,
      typingSeconds: 1,
      workingHoursPerDay: 24,
      outreachMode: "cold_mass"
    })
  });

  assert.equal(response.status, 422);
  instance.close();
});

test("snapshot includes crm analytics", async () => {
  const instance = await listen();
  const { port } = instance.address();

  const response = await fetch(`http://localhost:${port}/api/snapshot`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.ok(payload.accounts.length > 0);
  assert.ok(payload.analytics.contactsTotal > 0);
  instance.close();
});
