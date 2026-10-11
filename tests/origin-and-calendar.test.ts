import test from 'node:test';
import assert from 'node:assert/strict';
import { requestOrigin, isSameOriginRequest } from '../lib/auth/request-origin';
import { formatDate } from '../lib/format';
import { personUpdateSchema } from '../lib/validators';

test('normalized Next URLs use the actual loopback Host for Origin and reject foreign hosts/sites', () => {
  const request = (host: string, origin: string, site = 'same-origin') => new Request('http://localhost:3000/api/setup', { method: 'POST', headers: { Host: host, Origin: origin, 'Sec-Fetch-Site': site } });
  assert.equal(requestOrigin(request('127.0.0.1:3000', 'http://127.0.0.1:3000')), 'http://127.0.0.1:3000');
  assert.equal(isSameOriginRequest(request('127.0.0.1:3000', 'http://127.0.0.1:3000')), true);
  assert.equal(isSameOriginRequest(request('localhost:3000', 'http://127.0.0.1:3000')), false);
  assert.equal(isSameOriginRequest(request('localhost:3000', 'http://localhost:3000', 'cross-site')), false);
  assert.equal(requestOrigin(request('other.example:3000', 'http://other.example:3000')), null);
  assert.equal(requestOrigin(request('user@localhost:3000', 'http://localhost:3000')), null);
});
test('card calendar dates retain their day in negative timezones and can be explicitly cleared', () => {
  assert.equal(formatDate('1980-03-04'), '04/03/1980');
  assert.equal(formatDate('2026-10-11T00:00:00.000Z'), '11/10/2026');
  assert.equal(personUpdateSchema.parse({ birthDate: null }).birthDate, null);
  assert.equal(personUpdateSchema.safeParse({ birthDate: '2026-02-30' }).success, false);
});
