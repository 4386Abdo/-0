import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = 'http://127.0.0.1:3000';

test('GET /api/state returns clean data with zero leaked secrets or credentials', async () => {
  const res = await fetch(`${baseUrl}/api/state`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.ok(body.data);
  assert.equal(body.data.pin, undefined);
  assert.equal(body.data.salt, undefined);
  assert.equal(body.data.hash, undefined);
  assert.equal(body.data.settings?.mongo_uri, undefined);
  assert.equal(body.data.settings?.gemini_api_key, undefined);
});

test('Mutations without manager session return 401 Unauthorized', async () => {
  const endpoints = [
    { url: `${baseUrl}/api/items`, method: 'POST', body: { name: 'ورق', unit: 'رزمة', category_id: 'cat-1' } },
    { url: `${baseUrl}/api/items/123`, method: 'PUT', body: { name: 'ورق معدل' } },
    { url: `${baseUrl}/api/items/123`, method: 'DELETE' },
    { url: `${baseUrl}/api/movements`, method: 'POST', body: { itemId: '1', changeAmount: 5, type: 'supply' } },
    { url: `${baseUrl}/api/movements/undo`, method: 'POST', body: { movementId: '1' } },
    { url: `${baseUrl}/api/job-templates/apply`, method: 'POST', body: { templateId: '1', multiplier: 1 } },
    { url: `${baseUrl}/api/stocktake`, method: 'POST', body: { adjustments: [] } }
  ];

  for (const ep of endpoints) {
    const res = await fetch(ep.url, {
      method: ep.method,
      headers: { 'Content-Type': 'application/json' },
      body: ep.body ? JSON.stringify(ep.body) : undefined
    });
    assert.equal(res.status, 401, `Expected 401 for ${ep.method} ${ep.url}`);
    const data = await res.json();
    assert.equal(data.success, false);
    assert.ok(data.error.includes('تسجيل دخول المدير'));
  }
});

test('Old insecure endpoints /api/master-state and /api/db/connect return 404', async () => {
  const resMaster = await fetch(`${baseUrl}/api/master-state`);
  assert.equal(resMaster.status, 404);

  const resConnect = await fetch(`${baseUrl}/api/db/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri: 'mongodb://attacker' })
  });
  assert.equal(resConnect.status, 404);
});

test('Login authentication flow and session cookie security', async () => {
  // 1. Wrong PIN returns 401
  const failRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '000000' })
  });
  assert.equal(failRes.status, 401);
  const failData = await failRes.json();
  assert.equal(failData.success, false);

  // 2. Successful Login with initial PIN (102938)
  const okRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '102938' })
  });
  assert.equal(okRes.status, 200);
  const okData = await okRes.json();
  assert.equal(okData.success, true);
  assert.equal(okData.must_change_pin, true);

  // Verify HttpOnly cookie header
  const cookieHeader = okRes.headers.get('set-cookie');
  assert.ok(cookieHeader);
  assert.ok(cookieHeader.includes('studio_session='));
  assert.ok(cookieHeader.includes('HttpOnly'));
  assert.ok(cookieHeader.includes('SameSite=Strict'));

  // Extract session cookie for authorized requests
  const sessionCookie = cookieHeader.split(';')[0];

  // 3. /api/auth/me returns manager: true
  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { 'Cookie': sessionCookie }
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.manager, true);

  // 4. Strict Zero-Price Policy: Sending 'price' must be rejected with 400
  const priceRes = await fetch(`${baseUrl}/api/items`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie
    },
    body: JSON.stringify({
      sku: 'SKU-PRICE-TEST',
      name: 'خامة بسعر غير قانوني',
      category_id: 'cat-1',
      unit: 'قطعة',
      quantity: 5,
      price: 250 // Illegal field!
    })
  });
  assert.equal(priceRes.status, 400);

  // 5. Create valid item with clean quantity
  const createRes = await fetch(`${baseUrl}/api/items`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie
    },
    body: JSON.stringify({
      sku: 'SKU-SEC-1',
      name: 'خامة مؤمنة لاختبار النظام',
      category_id: 'cat-1',
      unit: 'قطعة',
      quantity: 50,
      min_limit: 10,
      reorder_qty: 20
    })
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.success, true);
  assert.ok(created.item.id);
  const testItemId = created.item.id;

  // 6. Record quick supply movement
  const movRes = await fetch(`${baseUrl}/api/movements`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie
    },
    body: JSON.stringify({
      itemId: testItemId,
      changeAmount: 15,
      type: 'supply',
      reason: 'توريد دفعة جديدة للتجربة'
    })
  });
  assert.equal(movRes.status, 201);
  const movData = await movRes.json();
  assert.equal(movData.newQuantity, 65);
  const movId = movData.movement.id;

  // 7. Prevent deleting item with movements history
  const delBlockedRes = await fetch(`${baseUrl}/api/items/${encodeURIComponent(testItemId)}`, {
    method: 'DELETE',
    headers: { 'Cookie': sessionCookie }
  });
  assert.equal(delBlockedRes.status, 400);
  const delBlockedData = await delBlockedRes.json();
  assert.ok(delBlockedData.error.includes('حركات مسجلة'));

  // 8. Undo movement
  const undoRes = await fetch(`${baseUrl}/api/movements/undo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie
    },
    body: JSON.stringify({ movementId: movId })
  });
  assert.equal(undoRes.status, 200);
  const undoData = await undoRes.json();
  assert.equal(undoData.newQuantity, 50);

  // 9. Prevent double undo
  const doubleUndoRes = await fetch(`${baseUrl}/api/movements/undo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': sessionCookie
    },
    body: JSON.stringify({ movementId: movId })
  });
  assert.equal(doubleUndoRes.status, 400);

  // 10. Logout manager
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Cookie': sessionCookie }
  });
  assert.equal(logoutRes.status, 200);

  // 11. /api/auth/me after logout returns manager: false
  const meAfterLogout = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(meAfterLogout.status, 200);
  const meAfterData = await meAfterLogout.json();
  assert.equal(meAfterData.manager, false);
});
