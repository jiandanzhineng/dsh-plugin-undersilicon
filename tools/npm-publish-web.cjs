const N = 'C:/Program Files/nodejs/node_modules/npm/node_modules/';
const { publish } = require(N + 'libnpmpublish');
const pacote = require(N + 'pacote');
const fetch = require(N + 'npm-registry-fetch');
const fs = require('fs'), os = require('os'), path = require('path');
const reg = 'https://registry.npmjs.org/';
const rc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
const token = rc.match(/\/\/registry\.npmjs\.org\/:_authToken=(.+)/)[1].trim();
const dir = process.argv[2];
(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const tarball = await pacote.tarball('file:' + dir, { Arborist: require(N + '@npmcli/arborist') });
  const opts = { registry: reg, forceAuth: { token }, access: 'public', defaultTag: 'latest', authType: 'web', npmCommand: 'publish', headers: { 'npm-auth-type': 'web', 'npm-command': 'publish' } };
  try { await publish(manifest, tarball, opts); console.log('PUBLISHED (no otp)'); return; }
  catch (e) {
    if (e.code !== 'EOTP' || !e.body?.authUrl) { console.log('BODY', JSON.stringify(e.body)); throw e; }
    console.log('AUTH_URL ' + e.body.authUrl); 
    let otp;
    for (let i = 0; i < 200 && !otp; i++) {
      const res = await fetch(e.body.doneUrl, { registry: reg, forceAuth: { token } });
      if (res.status === 200) { otp = (await res.json()).token; break; }
      await new Promise(r => setTimeout(r, 3000));
    }
    if (!otp) throw new Error('timeout waiting for web auth');
    await publish(manifest, tarball, { ...opts, otp });
    console.log('PUBLISHED');
  }
})().catch(e => { console.error('FAIL', e.code, e.message); process.exit(1); });
