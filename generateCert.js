const { generateKeyPairSync, createSign } = require('crypto');
const fs = require('fs');

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

// Use Node.js built-in X509Certificate (available from Node 15+)
const { X509Certificate } = require('crypto');

// We'll use a simpler approach - forge the cert manually via node's tls
// Actually let's use the forge library alternative: pure JS implementation

// Build a minimal self-signed cert using ASN.1 manually
function encodeLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeSeq(buf) {
  return Buffer.concat([Buffer.from([0x30]), encodeLength(buf.length), buf]);
}

function encodeInt(buf) {
  // ensure positive
  if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0x00]), buf]);
  return Buffer.concat([Buffer.from([0x02]), encodeLength(buf.length), buf]);
}

function encodeBitString(buf) {
  const inner = Buffer.concat([Buffer.from([0x00]), buf]);
  return Buffer.concat([Buffer.from([0x03]), encodeLength(inner.length), inner]);
}

function encodeOctetString(buf) {
  return Buffer.concat([Buffer.from([0x04]), encodeLength(buf.length), buf]);
}

function encodeOID(oid) {
  const parts = oid.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const tmp = [n & 0x7f];
    n >>= 7;
    while (n > 0) { tmp.unshift((n & 0x7f) | 0x80); n >>= 7; }
    bytes.push(...tmp);
  }
  const buf = Buffer.from(bytes);
  return Buffer.concat([Buffer.from([0x06]), encodeLength(buf.length), buf]);
}

function encodeUTF8String(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([Buffer.from([0x0c]), encodeLength(buf.length), buf]);
}

function encodeGeneralizedTime(date) {
  const s = date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  const buf = Buffer.from(s, 'ascii');
  return Buffer.concat([Buffer.from([0x18]), encodeLength(buf.length), buf]);
}

function encodeName(cn) {
  const oid = encodeOID('2.5.4.3'); // commonName
  const val = encodeUTF8String(cn);
  const atv = encodeSeq(Buffer.concat([oid, val]));
  const rdn = Buffer.concat([Buffer.from([0x31]), encodeLength(atv.length), atv]);
  return encodeSeq(rdn);
}

// Export public key as DER
const pubDer = publicKey.export({ type: 'spki', format: 'der' });
const privDer = privateKey.export({ type: 'pkcs8', format: 'der' });

const notBefore = new Date();
const notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

const version = Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02]); // v3
const serial = encodeInt(Buffer.from([0x01]));
const sigAlgOID = encodeOID('1.2.840.113549.1.1.11'); // sha256WithRSAEncryption
const nullParam = Buffer.from([0x05, 0x00]);
const sigAlg = encodeSeq(Buffer.concat([sigAlgOID, nullParam]));
const issuer = encodeName('exam-monitor');
const subject = encodeName('exam-monitor');
const validity = encodeSeq(Buffer.concat([
  encodeGeneralizedTime(notBefore),
  encodeGeneralizedTime(notAfter)
]));
const pubKeyInfo = Buffer.from(pubDer);

const tbsCert = encodeSeq(Buffer.concat([
  version, serial, sigAlg, issuer, validity, subject, pubKeyInfo
]));

// Sign
const sign = createSign('sha256');
sign.update(tbsCert);
const signature = sign.sign(privateKey);

const cert = encodeSeq(Buffer.concat([
  tbsCert,
  sigAlg,
  encodeBitString(signature)
]));

// Convert to PEM
function toPem(label, der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

fs.writeFileSync('cert.pem', toPem('CERTIFICATE', cert));
fs.writeFileSync('key.pem', toPem('PRIVATE KEY', privDer));

console.log('✅ cert.pem ו-key.pem נוצרו בהצלחה!');
