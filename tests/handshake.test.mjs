import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const {bridgeSession} = await import('../extension/handshake.js');

const TOKEN = 'pairing-token-'.repeat(4);
const SERVER_NONCE = 'a'.repeat(32);
const mac = (token, message) => createHmac('sha256', token).update(message).digest('hex');
const info = {version: '0.5.0', capabilities: ['policy_v2']};
const command = {type: 'command', id: '1', job: {kind: 'tabs'}};

function socket() {
  return {sent: [], closed: false, send(data) { this.sent.push(JSON.parse(data)); }, close() { this.closed = true; }};
}

async function greeted(token = TOKEN) {
  const ws = socket();
  const receive = bridgeSession(ws, token, info);
  assert.equal(await receive({type: 'challenge', nonce: SERVER_NONCE}), null);
  return {ws, receive, hello: ws.sent[0]};
}

test('squatter receiving the hello never sees the token', async () => {
  const {ws, hello} = await greeted();
  assert.equal(ws.sent.length, 1);
  assert.ok(!JSON.stringify(ws.sent).includes(TOKEN));
  assert.equal(hello.type, 'hello');
  assert.match(hello.nonce, /^[0-9a-f]{32}$/);
  assert.equal(hello.mac, mac(TOKEN, `ext\n${SERVER_NONCE}\n${hello.nonce}`));
  assert.deepEqual(hello.capabilities, info.capabilities);
});

test('commands run only after the bridge proves the token', async () => {
  const {ws, receive, hello} = await greeted();
  const ready = {type: 'ready', protocol: 2, mac: mac(TOKEN, `srv\n${hello.nonce}\n${SERVER_NONCE}`)};
  // Delivered back to back: the command waits for the ready verification.
  const [r, c] = await Promise.all([receive(ready), receive(command)]);
  assert.equal(r, ready);
  assert.equal(c, command);
  assert.equal(ws.closed, false);
});

for (const [name, readyMac] of [
  ['wrong token', n => mac('squatter', `srv\n${n}\n${SERVER_NONCE}`)],
  ['reflected extension mac', n => mac(TOKEN, `ext\n${SERVER_NONCE}\n${n}`)],
  ['missing mac', () => undefined],
  ['malformed mac', () => 'zz'.repeat(32)],
]) {
  test(`server ${name} closes the socket and refuses commands`, async () => {
    const {ws, receive, hello} = await greeted();
    const [r, c] = await Promise.all([receive({type: 'ready', protocol: 2, mac: readyMac(hello.nonce)}), receive(command)]);
    assert.equal(r, null);
    assert.equal(c, null);
    assert.equal(ws.closed, true);
    assert.equal(await receive(command), null);
  });
}

test('commands or ready before a challenge are refused', async () => {
  for (const first of [command, {type: 'ready', protocol: 2, mac: 'a'.repeat(64)}]) {
    const ws = socket();
    const receive = bridgeSession(ws, TOKEN, info);
    assert.equal(await receive(first), null);
    assert.equal(ws.closed, true);
    assert.deepEqual(ws.sent, []);
  }
});

test('malformed or repeated challenges are refused', async () => {
  const ws = socket();
  assert.equal(await bridgeSession(ws, TOKEN, info)({type: 'challenge', nonce: 'short'}), null);
  assert.equal(ws.closed, true);
  const {ws: again, receive} = await greeted();
  assert.equal(await receive({type: 'challenge', nonce: SERVER_NONCE}), null);
  assert.equal(again.closed, true);
  assert.equal(again.sent.length, 1);
});
