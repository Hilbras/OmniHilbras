import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateHostname } from '../dist/src/core/index.js';

/**
 * The address ranges a saved provider endpoint may not reach.
 *
 * This is not a complete SSRF defence on its own — DNS rebinding is handled separately at request
 * time — but it is the list every literal is checked against before a request is built. The ranges
 * below were missing, and each one is a real target rather than a theoretical one: 192.0.0.192 is a
 * metadata service on some clouds.
 */

test('reserved and special-purpose IPv4 ranges are refused', () => {
  for (const address of ['192.0.0.192', '198.18.0.1', '198.19.255.255', '240.0.0.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateHostname(address), true, `${address} must be refused`);
  }
});

test('public addresses and hostnames are still allowed', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '192.0.2.10', '198.20.0.1', 'api.example.com']) {
    assert.equal(isPrivateHostname(address), false, `${address} must be allowed`);
  }
});

test('the ranges that were already refused stay refused', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
    assert.equal(isPrivateHostname(address), true, `${address} must stay refused`);
  }
});
