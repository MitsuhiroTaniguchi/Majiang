"use strict";

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.LIVE_PORT || '8888');
const DIST_DIR = path.join(__dirname, 'dist');
const PAIPU_DIR = path.join(__dirname, 'paipu');

const sseClients = new Set();
let lastKaiju = null;
let lastQipai = null;
let eventLog = [];

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.gif':  'image/gif',
    '.png':  'image/png',
    '.wav':  'audio/wav',
    '.svg':  'image/svg+xml',
};

function serveStatic(req, res) {
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/live.html';
    const filePath = path.join(DIST_DIR, urlPath);
    if (!filePath.startsWith(DIST_DIR)) {
        res.writeHead(403); res.end(); return;
    }
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
}

function servePaipuList(req, res) {
    fs.readdir(PAIPU_DIR, (err, files) => {
        if (err) { res.writeHead(500); res.end('[]'); return; }
        const jsonFiles = files.filter(f => f.endsWith('.json')).sort();
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(jsonFiles));
    });
}

function servePaipuFile(req, res, filename) {
    if (filename.includes('..') || filename.includes('/')) {
        res.writeHead(403); res.end(); return;
    }
    const filePath = path.join(PAIPU_DIR, filename);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
    });
}

const server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/paipu/') {
        return servePaipuList(req, res);
    }
    if (urlPath.startsWith('/paipu/') && urlPath.endsWith('.json')) {
        return servePaipuFile(req, res, urlPath.slice(7));
    }
    if (req.url === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        res.write(':\n\n');
        if (lastKaiju) res.write(`event: kaiju\ndata: ${JSON.stringify(lastKaiju)}\n\n`);
        if (lastQipai) res.write(`event: qipai\ndata: ${JSON.stringify(lastQipai)}\n\n`);
        for (const entry of eventLog) {
            res.write(`event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`);
        }
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }
    serveStatic(req, res);
});

server.listen(PORT, () => {
    console.log(`Live viewer: http://localhost:${PORT}/`);
});

function broadcast(event, data) {
    if (event === 'kaiju') {
        lastKaiju = data;
        lastQipai = null;
        eventLog = [];
    } else if (event === 'qipai') {
        lastQipai = data;
        eventLog = [];
    } else {
        eventLog.push({ event, data });
    }
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        client.write(msg);
    }
}

module.exports = { broadcast };
