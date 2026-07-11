// VFR Router — OpenAIP Proxy Server
// Run: node server.js YOUR_API_KEY
// Then open http://localhost:3000 in your browser

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const API_KEY = process.argv[2];

if (!API_KEY) {
  console.error('Usage: node server.js YOUR_OPENAIP_API_KEY');
  process.exit(1);
}

console.log(`VFR Router proxy starting on http://localhost:${PORT}`);
console.log(`API key: ${API_KEY.slice(0, 8)}...`);

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  // Serve the HTML file
  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    const filePath = path.join(__dirname, 'vfr-router.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('vfr-router.html not found — make sure it is in the same folder as server.js');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
      });
      res.end(data);
    });
    return;
  }

  // Serve country KB files under /kb/*.json. Path is constrained to prevent
  // directory traversal; only simple lowercase basenames are accepted.
  if (parsed.pathname.startsWith('/kb/')) {
    const name = parsed.pathname.slice(4);
    if (!/^[a-z0-9_-]+\.json$/.test(name)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid kb file name' }));
      return;
    }
    const filePath = path.join(__dirname, 'kb', name);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `kb not found: ${name}` }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
    return;
  }

  // Proxy airspace API calls
  if (parsed.pathname === '/api/airspaces') {
    const bbox = parsed.query.bbox || '';
    const limit = parsed.query.limit || '300';
    const page = parsed.query.page || '1';

    const upstream = `https://api.core.openaip.net/api/airspaces?bbox=${encodeURIComponent(bbox)}&limit=${limit}&page=${page}`;

    console.log(`Fetching: ${upstream}`);

    const options = {
      headers: {
        'x-openaip-api-key': API_KEY,
        'Accept': 'application/json'
      }
    };

    const proxyReq = https.get(upstream, options, (proxyRes) => {
      let body = '';
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        console.log(`OpenAIP responded: ${proxyRes.statusCode}, ${body.length} bytes`);
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(body);
      });
    });

    proxyReq.on('error', (err) => {
      console.error('Upstream error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    proxyReq.setTimeout(15000, () => {
      proxyReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Timeout fetching OpenAIP' }));
    });

    return;
  }

  // Proxy airport search (OpenAIP core API). Used by the typeahead on the
  // departure/destination fields so a pilot can find an airport by ICAO, IATA
  // or name without knowing the exact code.
  if (parsed.pathname === '/api/airports') {
    const search = (parsed.query.search || '').trim();
    const bbox   = (parsed.query.bbox   || '').trim();
    // Two modes: ?search=<str> for typeahead, ?bbox=minLon,minLat,maxLon,maxLat
    // for bulk in-region airports used as A* turn-points.
    if (!search && !bbox) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    if (search && search.length < 2) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [] }));
      return;
    }
    const limit = parsed.query.limit || (bbox ? '1000' : '10');
    const page  = parsed.query.page  || '1';
    const qs = new URLSearchParams({ limit, page });
    if (search) qs.set('search', search);
    if (bbox)   qs.set('bbox',   bbox);
    const upstream = `https://api.core.openaip.net/api/airports?${qs.toString()}`;

    console.log(search ? `Airport search: "${search}"` : `Airport bbox: ${bbox}`);

    const options = {
      headers: {
        'x-openaip-api-key': API_KEY,
        'Accept': 'application/json'
      }
    };

    const apReq = https.get(upstream, options, (apRes) => {
      let body = '';
      apRes.on('data', c => body += c);
      apRes.on('end', () => {
        res.writeHead(apRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(body);
      });
    });
    apReq.on('error', (err) => {
      console.error('Airport search error:', err.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    apReq.setTimeout(15000, () => {
      apReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Timeout fetching airports' }));
    });
    return;
  }

  // Proxy elevation API (OpenTopoData, free public service, SRTM 30m)
  if (parsed.pathname === '/api/elevation') {
    const locations = parsed.query.locations || '';
    if (!locations) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'locations required' }));
      return;
    }
    const upstream = `https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locations)}`;
    console.log(`Elevation: ${locations.split('|').length} points`);
    const elevReq = https.get(upstream, (elevRes) => {
      let body = '';
      elevRes.on('data', c => body += c);
      elevRes.on('end', () => {
        res.writeHead(elevRes.statusCode, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(body);
      });
    });
    elevReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    elevReq.setTimeout(15000, () => {
      elevReq.destroy();
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Timeout fetching elevation' }));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✓ Ready — open http://localhost:${PORT} in your browser\n`);
});
