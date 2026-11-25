const https = require('https');
const crypto = require('crypto');

const getCfg = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };

const reqHttps = (opts, body = null) => new Promise((resolve, reject) => {
  const r = https.request(opts, (res) => {
    const c = [];
    res.on('data', d => c.push(d));
    res.on('end', () => resolve(Buffer.concat(c)));
  });
  r.on('error', reject);
  if (body) r.write(body);
  r.end();
});

function decodeBencode(buf, o = 0) {
  const c = buf.at(o);
  if (c === 105) { const e = buf.indexOf(101, o); return [parseInt(buf.slice(o + 1, e).toString('utf8'), 10), e + 1]; }
  if (c === 108) { const l = []; let p = o + 1; while (buf.at(p) !== 101) { const [v, np] = decodeBencode(buf, p); l.push(v); p = np; } return [l, p + 1]; }
  if (c === 100) {
    const d = {}; let p = o + 1, s = -1, e = -1;
    while (buf.at(p) !== 101) {
      const [kb, np] = decodeBencode(buf, p); const k = kb.toString();
      if (k === 'info') s = np;
      const [v, ap] = decodeBencode(buf, np);
      if (k === 'info') e = ap;
      d[k] = v; p = ap;
    }
    if (s !== -1 && e !== -1) d._raw = buf.slice(s, e);
    return [d, p + 1];
  }
  const col = buf.indexOf(58, o); const len = parseInt(buf.slice(o, col).toString('utf8'), 10);
  return [buf.slice(col + 1, col + 1 + len), col + 1 + len];
}

function parseTorrent(buf) {
  const [t] = decodeBencode(buf);
  if (!t?._raw) return null;
  const infoHash = crypto.createHash('sha1').update(t._raw).digest('hex');
  const length = Array.isArray(t.info.files) ? t.info.files.reduce((a, f) => a + (f.length || 0), 0) : (t.info.length || 0);
  const tr = [];
  if (t.announce) tr.push(t.announce.toString());
  if (Array.isArray(t['announce-list'])) t['announce-list'].forEach(tier => Array.isArray(tier) && tier.forEach(x => tr.push(x.toString())));
  return { infoHash, length, trackers: [...new Set(tr)] };
}

async function dbxList(token, folder) {
  let entries = [];
  let body = JSON.stringify({ path: folder || '', recursive: true });
  let data = await reqHttps({ hostname: '://dropboxapi.com', path: '/2/files/list_folder', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  let json = JSON.parse(data.toString());
  if (json.entries) entries.push(...json.entries);
  while (json.has_more && json.cursor) {
    body = JSON.stringify({ cursor: json.cursor });
    data = await reqHttps({ hostname: '://dropboxapi.com', path: '/2/files/list_folder/continue', method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    json = JSON.parse(data.toString());
    if (json.entries) entries.push(...json.entries);
  }
  return entries;
}

async function getTitle(type, id) {
  const data = await reqHttps({ hostname: 'v3-cinemeta.strem.io', path: `/meta/${type}/${id.split(':').at(0)}.json`, method: 'GET' });
  return JSON.parse(data.toString())?.meta?.name || '';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const fullUrl = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const cfgParam = fullUrl.searchParams.get('cfg');
  const route = fullUrl.pathname.replace(/^\/api\/?/, '');

  if (!cfgParam) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dropbox Stremio</title>
<style>body{font-family:sans-serif;background:#121212;color:#fff;display:flex;justify-content:center;padding-top:50px}.box{background:#1e1e1e;padding:30px;border-radius:12px;width:400px}input{width:100%;padding:10px;margin:8px 0 16px;border-radius:6px;border:1px solid #333;background:#2a2a2a;color:#fff;box-sizing:border-box}button{width:100%;padding:12px;background:#7b5bf5;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer;font-weight:bold}</style>
</head><body><div class="box"><h2>Dropbox за Stremio</h2><label>Dropbox Access Token:</label><input type="password" id="t" placeholder="sl.u..."><label>Папка (по желание):</label><input type="text" id="f" placeholder="Остави празно за App Folder"><button onclick="go()">Инсталирай в Stremio</button></div>
<script>function go(){const t=document.getElementById('t').value.trim(),f=document.getElementById('f').value.trim();if(!t)return alert('Въведи Token!');const b=btoa(JSON.stringify({t,f})).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');window.location.href='stremio://'+window.location.host+'/api?cfg='+b;}</script></body></html>`);
  }

  if (!route || route === 'manifest.json') {
    return res.status(200).json({ id: 'community.dbx.personal', version: '1.0.2', name: 'My Dropbox Torrents & Subs', description: 'Лични торенти и субтитри от Dropbox', resources: ['stream', 'subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [] });
  }

  const cfg = getCfg(cfgParam);
  const parts = route.split('/').filter(Boolean);
  if (!cfg?.t || parts.length < 3) return res.status(200).json({ streams: [], subtitles: [] });

  try {
    const resType = parts.at(0);
    const mediaType = parts.at(1);
    const mediaId = parts.at(2).replace('.json', '');
    const title = await getTitle(mediaType, mediaId);
    const kw = title.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ').trim().split(/\s+/).filter(w => w.length > 2);
    if (!kw.length) return res.status(200).json({ streams: [], subtitles: [] });

    const files = await dbxList(cfg.t, cfg.f);
    const match = (ext) => files.filter(f => f['.tag'] === 'file' && f.name.toLowerCase().endsWith(ext) && kw.every(k => f.name.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ').includes(k)));

    if (resType === 'stream') {
      const streams = [];
      for (const f of match('.torrent')) {
        const buf = await reqHttps({ hostname: '://dropboxapi.com', path: '/2/files/download', method: 'POST', headers: { Authorization: 'Bearer ' + cfg.t, 'Dropbox-API-Arg': JSON.stringify({ path: f.path_lower }) } });
        const pt = parseTorrent(buf);
        if (pt?.infoHash) streams.push({ name: 'Dropbox', title: `📁 ${f.name}\n💾 ${(pt.length / 1073741824).toFixed(2)} GB`, infoHash: pt.infoHash, sources: pt.trackers.map(tr => 'tracker:' + tr) });
      }
      return res.status(200).json({ streams });
    }

    if (resType === 'subtitles') {
      const subtitles = [];
      for (const f of match('.srt')) {
        const body = JSON.stringify({ path: f.path_lower });
        const d = await reqHttps({ hostname: '://dropboxapi.com', path: '/2/files/get_temporary_link', method: 'POST', headers: { Authorization: 'Bearer ' + cfg.t, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
        const j = JSON.parse(d.toString());
        if (j?.link) subtitles.push({ id: f.id, url: j.link, lang: 'bul' });
      }
      return res.status(200).json({ subtitles });
    }
  } catch (e) {}
  return res.status(200).json({ streams: [], subtitles: [] });
};
