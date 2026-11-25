const https = require('https');
const crypto = require('crypto');

const API_HOST = ['api', 'dropboxapi', 'com'].join('.');
const CONTENT_HOST = ['content', 'dropboxapi', 'com'].join('.');
const META_HOST = ['v3-cinemeta', 'strem', 'io'].join('.');

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://public.popcorn-tracker.org:6969/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://://desync.com',
  'udp://://demonii.com'
];

const getCfg = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };

const asciiJson = (obj) => JSON.stringify(obj).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

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
  let length = 0;
  let fileIdx = 0;
  if (Array.isArray(t.info.files)) {
    let maxLen = -1;
    t.info.files.forEach((f, idx) => {
      const fl = f.length || 0;
      length += fl;
      const fname = Array.isArray(f.path) ? f.path.at(-1).toString().toLowerCase() : '';
      if (/\.(mkv|mp4|avi|mov|wmv|m4v)$/.test(fname) && fl > maxLen) {
        maxLen = fl;
        fileIdx = idx;
      }
    });
  } else {
    length = t.info.length || 0;
  }
  const tr = [...PUBLIC_TRACKERS];
  if (t.announce) tr.unshift(t.announce.toString());
  if (Array.isArray(t['announce-list'])) t['announce-list'].forEach(tier => Array.isArray(tier) && tier.forEach(x => tr.unshift(x.toString())));
  return { infoHash, length, fileIdx, trackers: [...new Set(tr)] };
}

async function dbxSearch(token, query, folder, ext) {
  const options = { filename_only: true, max_results: 100, file_extensions: [ext] };
  if (folder) options.path = folder.startsWith('/') ? folder : '/' + folder;
  const body = JSON.stringify({ query, options });
  const data = await reqHttps({
    hostname: API_HOST,
    path: '/2/files/search_v2',
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  const json = JSON.parse(data.toString());
  return (json.matches || []).map(m => m.metadata?.metadata).filter(Boolean);
}

async function getTitle(type, id) {
  const data = await reqHttps({ hostname: META_HOST, path: `/meta/${type}/${id.split(':').at(0)}.json`, method: 'GET' });
  return JSON.parse(data.toString())?.meta?.name || '';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const fullUrl = new URL(req.url, 'https://' + (req.headers.host || 'localhost'));
  const cleanPath = fullUrl.pathname.replace(/^\/api\/?/, '');
  const segs = cleanPath.split('/').filter(Boolean);

  if (!segs.length || segs.at(0) === 'manifest.json') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Dropbox Stremio</title>
<style>body{font-family:sans-serif;background:#121212;color:#fff;display:flex;justify-content:center;padding-top:50px}.box{background:#1e1e1e;padding:30px;border-radius:12px;width:400px}input{width:100%;padding:10px;margin:8px 0 16px;border-radius:6px;border:1px solid #333;background:#2a2a2a;color:#fff;box-sizing:border-box}button{width:100%;padding:12px;background:#7b5bf5;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer;font-weight:bold}</style>
</head><body><div class="box"><h2>Dropbox за Stremio</h2><label>Dropbox Access Token:</label><input type="password" id="t" placeholder="sl.u..."><label>Папка (по желание):</label><input type="text" id="f" placeholder="Остави празно за App Folder"><button onclick="go()">Инсталирай в Stremio</button></div>
<script>function go(){const t=document.getElementById('t').value.trim(),f=document.getElementById('f').value.trim();if(!t)return alert('Въведи Token!');const b=btoa(JSON.stringify({t,f})).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');const parts=b.match(/.{1,200}/g).join('/');window.location.href='stremio://'+window.location.host+'/api/'+parts+'/manifest.json';}</script></body></html>`);
  }

  let cfgChunks = segs;
  let parts = [];
  const resIdx = segs.findIndex(s => s === 'manifest.json' || s === 'stream' || s === 'subtitles');
  if (resIdx !== -1) {
    cfgChunks = segs.slice(0, resIdx);
    parts = segs.slice(resIdx);
  }

  if (!parts.length || parts.at(0) === 'manifest.json') {
    return res.status(200).json({ id: 'community.dbx.personal', version: '1.0.8', name: 'My Dropbox Torrents & Subs', description: 'Лични торенти и субтитри от Dropbox', resources: ['stream', 'subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [] });
  }

  const cfg = getCfg(cfgChunks.join(''));
  if (!cfg?.t || parts.length < 3) return res.status(200).json({ streams: [], subtitles: [] });

  try {
    const resType = parts.at(0);
    const mediaType = parts.at(1);
    const rawId = decodeURIComponent(parts.at(2).replace('.json', ''));
    const idParts = rawId.split(':');
    const imdbId = idParts.at(0);
    const season = idParts.at(1);
    const episode = idParts.at(2);

    const title = await getTitle(mediaType, imdbId);
    const kw = title.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ').trim().split(/\s+/).filter(w => w.length > 1);
    if (!kw.length) return res.status(200).json({ streams: [], subtitles: [] });

    const ext = resType === 'stream' ? 'torrent' : 'srt';
    const found = await dbxSearch(cfg.t, title, cfg.f, ext);

    const sTag = season ? 's' + season.padStart(2, '0') : '';
    const epTag = (season && episode) ? sTag + 'e' + episode.padStart(2, '0') : '';

    const matches = found.filter(f => {
      if (f['.tag'] !== 'file') return false;
      const clean = f.name.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ');
      if (!kw.every(k => clean.includes(k))) return false;
      if (mediaType === 'series' && sTag) {
        if (resType === 'subtitles') return clean.includes(epTag);
        return clean.includes(epTag) || (clean.includes(sTag) && !/s\d{2}e\d{2}/.test(clean));
      }
      return true;
    });

    if (resType === 'stream') {
      const streams = [];
      for (const f of matches) {
        const buf = await reqHttps({
          hostname: CONTENT_HOST,
          path: '/2/files/download',
          method: 'POST',
          headers: { Authorization: 'Bearer ' + cfg.t, 'Dropbox-API-Arg': asciiJson({ path: f.path_lower }) }
        });
        const pt = parseTorrent(buf);
        if (pt?.infoHash) {
          const sources = [...pt.trackers.map(tr => 'tracker:' + tr), 'dht:' + pt.infoHash];
          streams.push({ name: 'Dropbox', title: `📁 ${f.name}\n💾 ${(pt.length / 1073741824).toFixed(2)} GB`, infoHash: pt.infoHash, fileIdx: pt.fileIdx, sources });
        }
      }
      return res.status(200).json({ streams });
    }

    if (resType === 'subtitles') {
      const subtitles = [];
      for (const f of matches) {
        const body = JSON.stringify({ path: f.path_lower });
        const d = await reqHttps({
          hostname: API_HOST,
          path: '/2/files/get_temporary_link',
          method: 'POST',
          headers: { Authorization: 'Bearer ' + cfg.t, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, body);
        const j = JSON.parse(d.toString());
        if (j?.link) subtitles.push({ id: f.id, url: j.link, lang: 'bul' });
      }
      return res.status(200).json({ subtitles });
    }
  } catch (e) {
    return res.status(200).json({ streams: [], subtitles: [], error: e.message });
  }
  return res.status(200).json({ streams: [], subtitles: [] });
};
