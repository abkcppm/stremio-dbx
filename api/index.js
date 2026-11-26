const https = require('https');
const crypto = require('crypto');

const API_HOST = ['api', 'dropboxapi', 'com'].join('.');
const CONTENT_HOST = ['content', 'dropboxapi', 'com'].join('.');
const META_HOST = ['v3-cinemeta', 'strem', 'io'].join('.');
const AUTH_URL = 'https://' + ['www', 'dropbox', 'com'].join('.') + '/oauth2/authorize';

const PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://://demonii.com'
];

const LOGO_SVG = `<svg xmlns="http://w3.org" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0061ff"/><stop offset="100%" stop-color="#7b5bf5"/></linearGradient></defs><rect width="256" height="256" rx="56" fill="url(#g)"/><path d="M88 64l40 26-40 26-40-26zm80 0l40 26-40 26-40-26zM48 142l40-26 40 26-40 26zm120-26l40 26-40 26-40-26zm-80 62l40-26 40 26-40 26z" fill="#fff" opacity="0.95"/><circle cx="192" cy="192" r="42" fill="#121212"/><path d="M180 174l28 18-28 18z" fill="#7b5bf5"/></svg>`;

const getCfg = (s) => { try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { return null; } };
const encCfg = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
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

async function getAccessToken(cfg) {
  if (cfg.t) return cfg.t;
  if (!cfg.r) return null;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cfg.r,
    client_id: process.env.DBX_APP_KEY,
    client_secret: process.env.DBX_APP_SECRET
  }).toString();
  const data = await reqHttps({
    hostname: API_HOST,
    path: '/oauth2/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params) }
  }, params);
  return JSON.parse(data.toString())?.access_token || null;
}

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
  let length = 0, fileIdx = 0;
  if (Array.isArray(t.info.files)) {
    let maxLen = -1;
    t.info.files.forEach((f, idx) => {
      const fl = f.length || 0;
      length += fl;
      const fname = Array.isArray(f.path) ? f.path.at(-1).toString().toLowerCase() : '';
      if (/\.(mkv|mp4|avi|mov|wmv|m4v)$/.test(fname) && fl > maxLen) { maxLen = fl; fileIdx = idx; }
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

async function getTempLink(token, pathLower) {
  const body = JSON.stringify({ path: pathLower });
  const d = await reqHttps({
    hostname: API_HOST,
    path: '/2/files/get_temporary_link',
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  return JSON.parse(d.toString())?.link || null;
}

async function getMeta(type, id) {
  const data = await reqHttps({ hostname: META_HOST, path: `/meta/${type}/${id.split(':').at(0)}.json`, method: 'GET' });
  const meta = JSON.parse(data.toString())?.meta || {};
  return { name: meta.name || '', year: (meta.releaseInfo || '').slice(0, 4) };
}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const host = req.headers.host || 'stremio-dbx.vercel.app';
  const redirectUri = `https://${host}/api/callback`;
  const fullUrl = new URL(req.url, `https://${host}`);
  const cleanPath = fullUrl.pathname.replace(/^\/api\/?/, '');
  const segs = cleanPath.split('/').filter(Boolean);

  if (segs.at(0) === 'logo.svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(LOGO_SVG);
  }

  if (segs.at(0) === 'login') {
    const state = encCfg({ f: fullUrl.searchParams.get('f') || '', ts: fullUrl.searchParams.get('ts') || '' });
    const url = `${AUTH_URL}?client_id=${process.env.DBX_APP_KEY}&response_type=code&token_access_type=offline&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
    res.writeHead(302, { Location: url });
    return res.end();
  }

  if (segs.at(0) === 'callback') {
    const code = fullUrl.searchParams.get('code');
    const st = getCfg(fullUrl.searchParams.get('state') || '') || {};
    if (!code) return res.status(400).send('Missing Dropbox authorization code.');
    const params = new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: process.env.DBX_APP_KEY,
      client_secret: process.env.DBX_APP_SECRET,
      redirect_uri: redirectUri
    }).toString();
    const data = await reqHttps({
      hostname: API_HOST,
      path: '/oauth2/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params) }
    }, params);
    const json = JSON.parse(data.toString());
    if (!json.refresh_token) return res.status(400).send('Dropbox OAuth Error: ' + data.toString());
    const cfgStr = encCfg({ r: json.refresh_token, f: st.f, ts: st.ts });
    const parts = cfgStr.match(/.{1,200}/g).join('/');
    const stremioUrl = `stremio://${host}/api/${parts}/manifest.json`;
    const httpsUrl = `https://${host}/api/${parts}/manifest.json`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dropbox Connected</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:16px}.box{background:#181b24;padding:32px;border-radius:16px;max-width:440px;width:100%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.45);border:1px solid #262b38}img{width:72px;height:72px;margin-bottom:12px}h2{margin:8px 0;font-size:22px}p{color:#9ca3af;font-size:14px;line-height:1.5}a.btn{display:block;padding:14px;background:linear-gradient(135deg,#0061ff,#7b5bf5);color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:16px;margin:20px 0 14px}input{width:100%;padding:10px;border-radius:8px;border:1px solid #2e3444;background:#10131a;color:#9ca3af;font-size:12px;box-sizing:border-box}</style></head><body><div class="box"><img src="/api/logo.svg" alt="Logo"><h2>✅ Dropbox е свързан! / Connected!</h2><p>Постоянният достъп е активиран (не изтича).<br>Permanent access enabled (never expires).</p><a class="btn" href="${stremioUrl}">🚀 Инсталирай в Stremio / Install</a><p style="font-size:12px">Или копирай линка за ръчно добавяне / Or copy manifest URL:</p><input type="text" value="${httpsUrl}" onclick="this.select()" readonly></div></body></html>`);
  }

  if (!segs.length || segs.at(0) === 'manifest.json') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dropbox Torrents & Subs for Stremio</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:16px}.box{background:#181b24;padding:32px;border-radius:16px;max-width:460px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.45);border:1px solid #262b38}.hdr{text-align:center;margin-bottom:20px}.hdr img{width:72px;height:72px;margin-bottom:8px}.hdr h2{margin:4px 0;font-size:22px}.hdr p{color:#9ca3af;font-size:13px;margin:0}label{display:block;font-size:13px;color:#d1d5db;margin-top:14px;font-weight:500}input{width:100%;padding:11px 12px;margin:6px 0 4px;border-radius:8px;border:1px solid #2e3444;background:#10131a;color:#fff;box-sizing:border-box;font-size:14px}.hint{font-size:11px;color:#6b7280;margin-bottom:8px}button{width:100%;padding:14px;background:#0061ff;color:#fff;border:none;border-radius:10px;font-size:16px;cursor:pointer;font-weight:600;margin-top:16px;transition:background .2s}button:hover{background:#0052d9}.info{margin-top:20px;padding-top:16px;border-top:1px solid #262b38;font-size:12px;color:#9ca3af;line-height:1.5}</style></head><body><div class="box"><div class="hdr"><img src="/api/logo.svg" alt="Logo"><h2>Dropbox Torrents & Subs</h2><p>Стриймвай личните си .torrent и .srt файлове от Dropbox<br>Stream your personal .torrent & .srt files from Dropbox</p></div><label>📁 Папка / Subfolder (по желание / optional):</label><input type="text" id="f" placeholder="Остави празно за всички папки / Leave empty for all"><div class="hint">Търси в <b>Dropbox &gt; Apps &gt; StremioDBX</b> (без база данни / stateless).</div><label>⚡ TorrServe URL (по желание / optional):</label><input type="text" id="ts" placeholder="http://127.0.0.1:8090"><div class="hint">За частни тракери (Zamunda/ArenaBG) на Android TV / For private trackers.</div><button onclick="location.href='/api/login?f='+encodeURIComponent(document.getElementById('f').value.trim())+'&ts='+encodeURIComponent(document.getElementById('ts').value.trim())">🔗 Свържи с Dropbox / Connect Dropbox</button><div class="info">🔒 <b>100% Stateless &amp; Private:</b> Сървърът не записва токени или файлове. Всеки потребител вижда единствено собствената си папка в Dropbox.</div></div></body></html>`);
  }

  let cfgChunks = segs, parts = [];
  const resIdx = segs.findIndex(s => s === 'manifest.json' || s === 'stream' || s === 'subtitles');
  if (resIdx !== -1) { cfgChunks = segs.slice(0, resIdx); parts = segs.slice(resIdx); }

  if (!parts.length || parts.at(0) === 'manifest.json') {
    return res.status(200).json({
      id: 'community.dbx.personal',
      version: '1.2.0',
      name: 'Dropbox Torrents & Subs',
      description: 'Stream your personal .torrent and .srt files directly from Dropbox (Stateless & Private).',
      logo: `https://${host}/api/logo.svg`,
      resources: ['stream', 'subtitles'],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false }
    });
  }

  const cfg = getCfg(cfgChunks.join(''));
  if ((!cfg?.t && !cfg?.r) || parts.length < 3) return res.status(200).json({ streams: [], subtitles: [] });

  try {
    const token = await getAccessToken(cfg);
    if (!token) return res.status(200).json({ streams: [], subtitles: [] });

    const resType = parts.at(0);
    const mediaType = parts.at(1);
    const rawId = decodeURIComponent(parts.at(2).replace('.json', ''));
    const [imdbId, season, episode] = rawId.split(':');

    const { name: title, year } = await getMeta(mediaType, imdbId);
    const kw = title.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ').trim().split(/\s+/).filter(w => w.length > 1);
    if (!kw.length) return res.status(200).json({ streams: [], subtitles: [] });

    const ext = resType === 'stream' ? 'torrent' : 'srt';
    const found = await dbxSearch(token, title, cfg.f, ext);

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
    }).sort((a, b) => (year && b.name.includes(year) ? 1 : 0) - (year && a.name.includes(year) ? 1 : 0));

    if (resType === 'stream') {
      const streams = [];
      const tsBase = (cfg.ts || '').replace(/\/+$/, '');
      for (const f of matches) {
        const buf = await reqHttps({
          hostname: CONTENT_HOST,
          path: '/2/files/download',
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Dropbox-API-Arg': asciiJson({ path: f.path_lower }) }
        });
        const pt = parseTorrent(buf);
        if (!pt?.infoHash) continue;
        const sizeGb = (pt.length / 1073741824).toFixed(2);
        if (tsBase) {
          const tLink = await getTempLink(token, f.path_lower);
          if (tLink) {
            streams.push({
              name: 'Dropbox (TorrServe)',
              title: `⚡ ${f.name}\n💾 ${sizeGb} GB`,
              url: `${tsBase}/stream?link=${encodeURIComponent(tLink)}&index=${pt.fileIdx + 1}&play`
            });
          }
        }
        streams.push({
          name: 'Dropbox (P2P)',
          title: `📁 ${f.name}\n💾 ${sizeGb} GB`,
          infoHash: pt.infoHash,
          fileIdx: pt.fileIdx,
          sources: [...pt.trackers.map(tr => 'tracker:' + tr), 'dht:' + pt.infoHash]
        });
      }
      return res.status(200).json({ streams });
    }

    if (resType === 'subtitles') {
      const subtitles = [];
      for (const f of matches) {
        const link = await getTempLink(token, f.path_lower);
        if (link) subtitles.push({ id: f.id, url: link, lang: 'bul', name: `📦 ${f.name}` });
      }
      return res.status(200).json({ subtitles });
    }
  } catch (e) {
    return res.status(200).json({ streams: [], subtitles: [], error: e.message });
  }
  return res.status(200).json({ streams: [], subtitles: [] });
};
