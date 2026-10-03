import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,cp,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {build,fingerprint} from './build.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), dist=path.join(root,'dist');
const original=await readFile(path.join(dist,'build-manifest.json'),'utf8');
const manifest=await build(root);
assert.equal(await readFile(path.join(dist,'build-manifest.json'),'utf8'),original,'Committed build is stale');
assert.equal(manifest.hash,'SHA-256/80');

// Verify content addresses and every dependency reachable from the actual production entry.
for(const [name,hash] of Object.entries(manifest.files)) {
  assert.equal(fingerprint(await readFile(path.join(dist,name))),hash);
  assert(name.includes(hash),`Filename is not a content fingerprint: ${name}`);
}
for(const name of await readdir(path.join(dist,'build'))) {
  const file=path.join(dist,'build',name), data=await readFile(file);
  assert(name.includes(fingerprint(data)),'An older fingerprint was overwritten');
  const text=data.toString();assert(!/\?v=/.test(text),'A release still relies on manual query versions');
  for(const match of text.matchAll(/(['"])(\.{1,2}\/[^'"\s]+\.(?:mjs|json|png|jpg|mp3|wav))\1/g)) {
    const target=path.resolve(path.dirname(file),match[2]);
    assert(target.startsWith(dist+path.sep));assert((await stat(target)).isFile(),`Broken built dependency: ${match[2]}`);
  }
}
const html=await readFile(path.join(dist,'index.html'),'utf8'), missing=await readFile(path.join(dist,'404.html'),'utf8');
assert(html.includes(manifest.entry));assert(!html.includes('?v='));
assert(missing.includes('href="/build/'));assert(missing.includes('href="/"'));
for(const page of [html,missing]) {
  assert(!/\s(?:style|on\w+)=/.test(page));assert(!/<style\b/.test(page));
  assert(!/<script\b(?![^>]*\bsrc=)[^>]*>/.test(page));
  for(const match of page.matchAll(/(?:href|src)="(\.?\/?(?:build|assets)\/[^"\s]+)"/g)) {
    assert((await stat(path.join(dist,match[1].replace(/^\.\//,'').replace(/^\//,'')))).isFile());
  }
}
const story=JSON.parse(await readFile(path.join(dist,'story.json'),'utf8'));
const sourceStory=JSON.parse(await readFile(path.join(root,'src/story.json'),'utf8'));
assert.equal(story.sourceHash,sourceStory.sourceHash);assert.deepEqual(story.maps,sourceStory.maps);
assert(!Object.hasOwn(story,'titleSettings'));assert(!Object.hasOwn(story,'talkSettings'));
const redirects=await readFile(path.join(dist,'_redirects'),'utf8');
assert.equal(redirects.trim().split('\n').length,45);
for(const line of redirects.trim().split('\n')) {
  const [from,to,code]=line.split(' ');assert.equal(code,'301');
  assert((await stat(path.join(dist,to.slice(1)))).isFile());
  await assert.rejects(stat(path.join(dist,from.slice(1))),{code:'ENOENT'});
}

// Cloudflare combines matching header rules. No response may receive two conflicting cache policies.
const headers=await readFile(path.join(dist,'_headers'),'utf8'), rules=[];
for(const line of headers.split('\n')) {
  if(!line.trim() || line.startsWith('#'))continue;
  if(!line.startsWith(' '))rules.push({pattern:line,headers:[]});
  else rules.at(-1).headers.push(line.trim());
}
const matched=url=>rules.filter(rule=>new RegExp('^'+rule.pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$').test(url)).flatMap(rule=>rule.headers);
for(const url of ['/', '/index.html','/404.html','/'+manifest.entry,'/assets/content/image.png','/app.mjs','/missing/path']) {
  const values=matched(url), cache=values.filter(value=>value.startsWith('Cache-Control:'));
  assert(cache.length<=1,`Conflicting cache headers on ${url}`);
  assert(values.includes('X-Content-Type-Options: nosniff'));
  const csp=values.find(value=>value.startsWith('Content-Security-Policy:'));
  assert(csp.includes("default-src 'self'"));assert(csp.includes("media-src 'self'"));assert(!csp.includes('unsafe-inline'));
  if(url.startsWith('/build/') || url.startsWith('/assets/content/'))assert(cache[0].endsWith('immutable'));
  else assert(!cache.some(value=>value.includes('immutable')));
}

// Changing a child, data, or asset propagates to the parent URL and never rewrites a prior release.
const temporary=await mkdtemp(path.join(os.tmpdir(),'lianpo-build-'));
try {
  await cp(path.join(root,'src'),path.join(temporary,'src'),{recursive:true});
  const first=await build(temporary), firstEntry=await readFile(path.join(temporary,'dist',first.entry));
  const engine=path.join(temporary,'src/engine.mjs');
  await writeFile(engine,(await readFile(engine,'utf8'))+'\n// Changed child for the cache propagation regression.\n');
  const second=await build(temporary);assert.notEqual(second.entry,first.entry);
  const sourceData=path.join(temporary,'src/story.json'), altered=JSON.parse(await readFile(sourceData,'utf8'));
  altered.title+=' · 建置驗證';await writeFile(sourceData,JSON.stringify(altered));
  const third=await build(temporary);assert.notEqual(third.entry,second.entry);
  const assetName=(await readdir(path.join(temporary,'src/assets'))).sort()[0];
  const asset=path.join(temporary,'src/assets',assetName);
  await writeFile(asset,Buffer.concat([await readFile(asset),Buffer.from('cache-test')]));
  const fourth=await build(temporary);assert.notEqual(fourth.entry,third.entry);
  assert.deepEqual(await readFile(path.join(temporary,'dist',first.entry)),firstEntry);
  const legacyBefore=await readFile(path.join(temporary,'dist/_redirects'),'utf8');
  assert.equal(legacyBefore,redirects,'An old alias was retargeted to newer bytes');
  const stable=JSON.stringify(fourth);assert.equal(JSON.stringify(await build(temporary)),stable);
} finally {await rm(temporary,{recursive:true,force:true});}

console.log(JSON.stringify({contentFingerprints:Object.keys(manifest.files).length,completeDependencyGraph:'passed',
  childAndDataPropagation:'passed',assetBytesPropagation:'passed',earlierReleaseRetained:'passed',
  deterministicBuild:'passed',legacyRedirects:45,cacheHeaderOverlap:'none',staticCspCompatibility:'passed',
  explicit404:'passed',unusedEditorSettings:'omitted'},null,2));
