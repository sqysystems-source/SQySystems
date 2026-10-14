import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTenantStore, storeApiUrl } from '../public/js/tenant-config.js';
import { categoryTree, optionalProductFields, encodeCsvCell, decodeCsvText } from '../public/js/category-model.js';
import { resolveListingPrice, parseEuroInput, toCents } from '../public/js/pricing.js';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const config = {
    storeName: 'AURA', storeApiBaseUrl: 'https://aura.example.com',
    firebaseConfig: { apiKey: 'public-web-api-key', authDomain: 'aura-test.firebaseapp.com', projectId: 'aura-test', storageBucket: 'aura-test.firebasestorage.app', messagingSenderId: '123456', appId: '1:123456:web:abc123' }
};
const copy = () => structuredClone(config);

test('canonical config and endpoint query routing', () => {
    const value = copy(); value.storeName = ' AURA '; value.storeApiBaseUrl += '/';
    const clean = validateTenantStore(value);
    assert.deepEqual(clean, config);
    assert.equal(storeApiUrl(clean, '/api/r2?action=upload-url'), 'https://aura.example.com/api/r2?action=upload-url');
    assert.equal(storeApiUrl(clean, '/api/send-email'), 'https://aura.example.com/api/send-email');
});
test('reject unsafe API origins', () => {
    for (const url of ['http://aura.example.com', '//evil.example', 'javascript:alert(1)', 'https://aura.example.com/api', 'https://aura.example.com/?x=1', 'https://aura.example.com/#x', 'https://user:password@aura.example.com', 'https://aura.example.com:444', '[https://aura.example.com](https://aura.example.com)']) {
        const value = copy(); value.storeApiBaseUrl = url;
        assert.throws(() => validateTenantStore(value), undefined, url);
    }
});
test('reject absent, malformed, secret-bearing and Master configs', () => {
    for (const mutate of [c => { delete c.firebaseConfig.apiKey; }, c => { c.firebaseConfig.private_key = 'secret'; }, c => { c.firebaseConfig.projectId = 'sqysystems-faa0e'; }, c => { c.firebaseConfig = []; }, c => { c.storeName = ''; }, c => { c.firebaseConfig.authDomain = 'https://aura.example.com'; }, c => { c.firebaseConfig.appId = 'bad'; }, c => { c.firebaseConfig.messagingSenderId = 'bad'; }]) {
        const value = copy(); mutate(value); assert.throws(() => validateTenantStore(value));
    }
    assert.throws(() => validateTenantStore(null));
});
test('endpoint allowlist prevents off-origin and path injection', () => {
    for (const path of ['//evil.example/api/r2', 'https://evil.example/api/r2', '/api/r2/../x', '/api/send-email#x', '/api/r2\n', '/api/other', '/api/r2?x=\\evil']) {
        assert.throws(() => storeApiUrl(config, path), undefined, path);
    }
    assert.throws(() => storeApiUrl(null, '/api/r2'));
});
test('existing taxonomy contracts and CSV round trips remain intact', () => {
    const tree = categoryTree([{ name: 'ΦΟΡΕΜΑ', sizes: true, colors: true, subcategories: [{ id: 'mini', name: 'MINI' }] }]);
    assert.deepEqual(optionalProductFields(tree, 'ΦΟΡΕΜΑ', 'mini', ' AURA '), { brand: 'AURA', subcategoryId: 'mini' });
    assert.deepEqual(optionalProductFields(tree, 'ΦΟΡΕΜΑ', '', ''), {});
    assert.throws(() => optionalProductFields(tree, 'OTHER', 'mini', ''));
    for (const value of ['=SUM(A1:A2)', "'original", 'normal']) {
        const encoded = encodeCsvCell(value); const cell = encoded.slice(1, -1).replaceAll('""', '"');
        assert.equal(decodeCsvText(cell), value);
    }
});
test('existing price contract remains in cents', () => {
    assert.equal(toCents(12.45), 1245);
    assert.deepEqual(parseEuroInput('12,45'), { ok: true, cents: 1245, value: 12.45 });
    const result = resolveListingPrice({ type: 'simple', price: 20, salePrice: 15 });
    assert.equal(result.unitCents, 1500);
});
const root = fileURLToPath(new URL('../', import.meta.url));
const allJs = [resolve(root, 'app.js'), resolve(root, 'firebase-config.js'), ...readdirSync(resolve(root, 'public/js')).filter(n => n.endsWith('.js')).map(n => resolve(root, 'public/js', n))];
test('all JS parses, local import paths and named export contracts resolve', () => {
    for (const file of allJs) {
        const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
            const target = resolve(dirname(file), match[2]);
            assert.ok(existsSync(target), `${file}: missing ${match[2]}`);
            const targetSource = readFileSync(target, 'utf8');
            for (const item of match[1].split(',')) {
                const name = item.trim().split(/\s+as\s+/)[0];
                if (!name) continue;
                assert.match(targetSource, new RegExp(`export(?:\\s+async)?\\s+(?:(?:function|const|let|class)\\s+${name}\\b|\\{[^}]*\\b${name}\\b)`), `${file}: missing export ${name}`);
            }
        }
        assert.ok(!source.includes('10.12.2'), `${file}: mixed SDK`);
        assert.ok(!/fetch\(['"]\/api\//.test(source), `${file}: unbridged API request`);
    }
});
test('six-line CORS snippet handles preflight and rejected origins before auth', () => {
    const md = readFileSync(resolve(root, 'ESHOP_CORS_INSTRUCTIONS.md'), 'utf8');
    const snippet = md.match(/```js\n([\s\S]*?)\n```/)[1];
    assert.equal(snippet.split('\n').length, 6);
    const handler = new Function('req', 'res', snippet + '\nreturn "authorized-handler";');
    const response = () => ({ headers: {}, status(code) { this.code = code; return this; }, setHeader(k,v) { this.headers[k] = v; }, end() { return 'ended'; }, json(data) { this.data = data; return 'json'; } });
    const preflight = response();
    assert.equal(handler({method:'OPTIONS', headers:{origin:'https://sqysystems.com'}},preflight),'ended');
    assert.equal(preflight.code,204);
    assert.equal(preflight.headers['Access-Control-Allow-Origin'],'https://sqysystems.com');
    assert.equal(preflight.headers['Access-Control-Allow-Headers'],'Authorization, Content-Type');
    const rejected = response(); handler({method:'POST',headers:{origin:'https://evil.example'}},rejected);
    assert.equal(rejected.code,403); assert.equal(rejected.headers['Access-Control-Allow-Origin'],undefined);
    assert.equal(handler({method:'POST',headers:{}},response()),'authorized-handler');
});
