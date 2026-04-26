import test from "node:test";
import assert from "node:assert/strict";
import { server } from "../src/server.js";

function listen() {
  return new Promise((resolve) => {
    const instance = server.listen(0, () => resolve(instance));
  });
}

async function authCookie(port) {
  const response = await fetch(`http://localhost:${port}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: `test-${Date.now()}-${Math.random()}@rs.local`,
      password: "password123"
    })
  });
  assert.equal(response.status, 201);
  return response.headers.get("set-cookie").split(";")[0];
}

test("api rejects account with unsafe policy", async () => {
  const instance = await listen();
  const { port } = instance.address();
  const cookie = await authCookie(port);

  const response = await fetch(`http://localhost:${port}/api/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
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
  const cookie = await authCookie(port);

  const response = await fetch(`http://localhost:${port}/api/snapshot`, {
    headers: { cookie }
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.ok(payload.accounts.length > 0);
  assert.ok(payload.analytics.contactsTotal > 0);
  instance.close();
});
