const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bencode = require('bencode');
const crypto = require('crypto');

const app = express();
app.use(cors());

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="bg">
    <head>
      <meta charset="UTF-8">
      <title>Dropbox Torrents & Subs за Stremio</title>
      <style>
        body { font-family: sans-serif; background: #121212; color: #fff; display: flex; justify-content: center; padding-top: 50px; }
        .box { background: #1e1e1e; padding: 30px; border-radius: 12px; width: 420px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); }
        input { width: 100%; padding: 10px; margin: 10px 0 20px; border-radius: 6px; border: 1px solid #333; background: #2a2a2a; color: #fff; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background: #7b5bf5; color: white; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; font-weight: bold; }
        button:hover { background: #6644e5; }
        small { color: #aaa; display: block; margin-top: -12px; margin-bottom: 15px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>Dropbox за Stremio</h2>
        <p>Въведи своя Dropbox Access Token. Данните ти се пазят само в твоя личен Stremio линк.</p>
        <label>Dropbox Access Token:</label>
        <input type="password" id="token" placeholder="sl.B..." required>
        <label>Път до папката в Dropbox (по желание):</label>
        <input type="text" id="folder" placeholder="Пр. /Torrents (остави празно за главната папка)">
        <small>Ако си избрал App Folder в Dropbox, остави празно.</small>
        <button onclick="install()">Инсталирай в Stremio</button>
      </div>
      <script>
        function install() {
          const token = document.getElementById('token').value.trim();
          const folder = document.getElementById('folder').value.trim();
          if (!token) return alert('Моля, въведи Dropbox Token!');
          const config = btoa(JSON.stringify({ token, folder }));
          const host = window.location.host;
          window.location.href = 'stremio://' + host + '/' + config + '/manifest.json';
        }
      </script>
    </body>
    </html>
  `);
});

function getConfig(configStr) {
  try {
    return JSON.parse(Buffer.from(configStr, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

function parseTorrentBuffer(buf) {
  const torrent = bencode.decode(buf);
  const infoEncoded = bencode.encode(torrent.info);
  const infoHash = crypto.createHash('sha1').update(infoEncoded).digest('hex');
  let length = 0;
  if (torrent.info.files) {
    length = torrent.info.files.reduce((acc, f) => acc + f.length, 0);
  } else {
    length = torrent.info.length || 0;
  }
  const trackers = [];
  if (torrent.announce) trackers.push(Buffer.from(torrent.announce).toString('utf8'));
  if (torrent['announce-list']) {
    torrent['announce-list'].forEach(tier => {
      tier.forEach(tr => trackers.push(Buffer.from(tr).toString('utf8')));
    });
  }
  return { infoHash, length, trackers: [...new Set(trackers)] };
}

app.get('/:config/manifest.json', (req, res) => {
  res.json({
    id: 'community.dropbox.torrents.subs',
    version: '1.0.0',
    name: 'My Dropbox Torrents & Subs',
    description: 'Лични торенти и субтитри директно от твоя Dropbox',
    resources: ['stream', 'subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
  });
});

async function listDropboxFiles(token, folder) {
  const response = await axios.post(
    'https://dropboxapi.com',
    { path: folder || '', recursive: true },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return response.data.entries || [];
}

async function getTitleFromImdb(type, imdbId) {
  const baseId = imdbId.split(':');
  const res = await axios.get(`https://strem.io{type}/${baseId}.json`);
  return res.data?.meta?.name || '';
}

app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const config = getConfig(req.params.config);
  if (!config || !config.token) return res.json({ streams: [] });

  try {
    const title = await getTitleFromImdb(req.params.type, req.params.id);
    if (!title) return res.json({ streams: [] });

    const cleanTitle = title.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ').trim();
    const keywords = cleanTitle.split(/\s+/).filter(w => w.length > 2);

    const files = await listDropboxFiles(config.token, config.folder);
    const torrentFiles = files.filter(f => f['.tag'] === 'file' && f.name.toLowerCase().endsWith('.torrent'));

    const matchedTorrents = torrentFiles.filter(f => {
      const fname = f.name.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ');
      return keywords.every(kw => fname.includes(kw));
    });

    const streams = [];
    for (const file of matchedTorrents) {
      const dlRes = await axios.post(
        'https://dropboxapi.com',
        null,
        {
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Dropbox-API-Arg': JSON.stringify({ path: file.path_lower })
          },
          responseType: 'arraybuffer'
        }
      );

      const parsed = parseTorrentBuffer(Buffer.from(dlRes.data));
      if (parsed && parsed.infoHash) {
        streams.push({
          name: 'Dropbox',
          title: `📁 ${file.name}\n💾 ${(parsed.length / (1024 ** 3)).toFixed(2)} GB`,
          infoHash: parsed.infoHash,
          sources: parsed.trackers.map(tr => `tracker:${tr}`)
        });
      }
    }

    res.json({ streams });
  } catch (err) {
    console.error(err.message);
    res.json({ streams: [] });
  }
});

app.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
  const config = getConfig(req.params.config);
  if (!config || !config.token) return res.json({ subtitles: [] });

  try {
    const title = await getTitleFromImdb(req.params.type, req.params.id);
    if (!title) return res.json({ subtitles: [] });

    const cleanTitle = title.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ').trim();
    const keywords = cleanTitle.split(/\s+/).filter(w => w.length > 2);

    const files = await listDropboxFiles(config.token, config.folder);
    const srtFiles = files.filter(f => f['.tag'] === 'file' && f.name.toLowerCase().endsWith('.srt'));

    const matchedSrts = srtFiles.filter(f => {
      const fname = f.name.toLowerCase().replace(/[^a-z0-9а-я]/gi, ' ');
      return keywords.every(kw => fname.includes(kw));
    });

    const subtitles = [];
    for (const file of matchedSrts) {
      const linkRes = await axios.post(
        'https://dropboxapi.com',
        { path: file.path_lower },
        { headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' } }
      );

      if (linkRes.data && linkRes.data.link) {
        subtitles.push({
          id: file.id,
          url: linkRes.data.link,
          lang: 'bul'
        });
      }
    }

    res.json({ subtitles });
  } catch (err) {
    console.error(err.message);
    res.json({ subtitles: [] });
  }
});

module.exports = app;
