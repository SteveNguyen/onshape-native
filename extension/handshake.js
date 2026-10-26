// Mutual HMAC handshake with the local bridge. The pairing token never crosses
// the socket: a process squatting on 127.0.0.1:8766 learns nothing from the hello
// and, lacking the token, cannot send the "srv" proof that unlocks commands.
const enc = new TextEncoder();
const NONCE = /^[0-9a-f]{32}$/;

const key = (token, usage) => crypto.subtle.importKey("raw", enc.encode(token), {name: "HMAC", hash: "SHA-256"}, false, [usage]);
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");

async function sign(token, message) { return hex(await crypto.subtle.sign("HMAC", await key(token, "sign"), enc.encode(message))); }

async function verify(token, message, mac) {
  if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const bytes = Uint8Array.from(mac.match(/../g), h => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", await key(token, "verify"), bytes, enc.encode(message));  // constant time
}

// Returns receive(message): resolves to the message only for an authenticated
// "ready" or "command"; any protocol violation closes the socket and yields null.
export function bridgeSession(socket, token, info) {
  let serverNonce = null, extNonce = null, verified = null;
  const reject = () => { socket.close(); return null; };
  return async function receive(message) {
    if (message?.type === "challenge") {
      if (serverNonce || !NONCE.test(message.nonce ?? "")) return reject();
      serverNonce = message.nonce;
      extNonce = hex(crypto.getRandomValues(new Uint8Array(16)));
      socket.send(JSON.stringify({type: "hello", nonce: extNonce, mac: await sign(token, `ext\n${serverNonce}\n${extNonce}`), ...info}));
      return null;
    }
    if (message?.type === "ready") {
      if (!extNonce || verified) return reject();
      // Stored before awaiting so a command delivered right after waits on it.
      verified = verify(token, `srv\n${extNonce}\n${serverNonce}`, message.mac);
      return (await verified) ? message : reject();
    }
    if (message?.type === "command") return verified && (await verified) ? message : reject();
    return null;
  };
}
