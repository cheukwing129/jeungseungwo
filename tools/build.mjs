import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const fingerprint=data=>createHash('sha256').update(data).digest('hex').slice(0,20);

async function exists(file) {
  try {return await readFile(file);} catch(error) {if(error.code==='ENOENT')return null;throw error;}
}

/** Produce complete deployable files, keeping earlier content addresses available for open clients. */
export async function build(root=project) {
  const source=path.join(root,'src'), output=path.join(root,'dist');
  await mkdir(path.join(output,'build'),{recursive:true});
  await mkdir(path.join(output,'assets/content'),{recursive:true});
  const produced=new Map(), aliases=new Map(), visiting=new Set(), legacy=new Map();
  const previous=await exists(path.join(output,'_redirects'));
  if(previous)for(const line of previous.toString().split('\n')) {
    const match=line.match(/^(\/assets\/[^\s]+) (\/assets\/content\/[^\s]+) 301$/);
    if(match)legacy.set(match[1],match[2]);
  }

  async function emit(name,data) {
    const target=path.join(output,name), old=await exists(target);
    if(old && !old.equals(Buffer.from(data)))throw new Error(`Immutable content changed at ${name}`);
    await mkdir(path.dirname(target),{recursive:true});
    if(!old)await writeFile(target,data);
    produced.set(name,fingerprint(data));
    return name;
  }

  for(const name of (await readdir(path.join(source,'assets'))).sort()) {
    const data=await readFile(path.join(source,'assets',name));
    const target=`assets/content/${fingerprint(data)}${path.extname(name).toLowerCase()}`;
    await emit(target,data);aliases.set(`assets/${name}`,target);
    if(!legacy.has(`/assets/${name}`))legacy.set(`/assets/${name}`,`/${target}`);
  }

  function replaceAssets(text,prefix) {
    return text.replace(/(['"])(\.?\/?assets\/[^'"\s]+)\1/g,(match,quote,url)=>{
      const target=aliases.get(url.replace(/^\.\//,'').replace(/^\//,''));
      if(!target)throw new Error(`Unmapped asset URL: ${url}`);
      return quote+prefix+target+quote;
    });
  }

  const assets=JSON.parse(await readFile(path.join(source,'assets.json'),'utf8'));
  for(const asset of Object.values(assets)) {
    const target=aliases.get(asset.src);
    if(!target)throw new Error(`Missing asset: ${asset.src}`);
    asset.src=target;
  }
  const story=JSON.parse(await readFile(path.join(source,'story.json'),'utf8'));
  // Editor settings have no role in the standalone runtime. Keep save identity and command positions intact.
  delete story.titleSettings;delete story.talkSettings;
  const dataFiles={'story.json':JSON.stringify(story),'assets.json':JSON.stringify(assets)};
  for(const [name,data] of Object.entries(dataFiles)) {
    const extension=path.extname(name), stem=path.basename(name,extension);
    const target=await emit(`build/${stem}.${fingerprint(data)}${extension}`,data);
    produced.set(name,target);await writeFile(path.join(output,name),data);
  }

  async function module(name) {
    if(typeof produced.get(name)==='string' && produced.get(name).startsWith('build/'))return produced.get(name);
    if(visiting.has(name))throw new Error(`Circular module imports require an explicit build rule: ${name}`);
    visiting.add(name);
    let text=await readFile(path.join(source,name),'utf8');
    const references=[...text.matchAll(/(['"])(\.\/[^'"\s]+\.(?:mjs|json))(?:\?[^'"\s]*)?\1/g)];
    for(const match of references) {
      const dependency=match[2].slice(2);
      const target=dependency.endsWith('.mjs')?await module(dependency):produced.get(dependency);
      if(!target)throw new Error(`Unknown module dependency: ${dependency}`);
      text=text.replaceAll(match[0],match[1]+'./'+path.posix.basename(target)+match[1]);
    }
    text=replaceAssets(text,'../');
    const target=await emit(`build/${path.basename(name,'.mjs')}.${fingerprint(text)}.mjs`,text);
    produced.set(name,target);visiting.delete(name);return target;
  }

  const files=(await readdir(source)).sort();
  for(const name of files.filter(name=>name.endsWith('.mjs'))) {
    await module(name);
    // Revalidated aliases retain old module URLs during the transition from manual query versions.
    await writeFile(path.join(output,name),await readFile(path.join(source,name)));
  }
  const css=replaceAssets(await readFile(path.join(source,'styles.css'),'utf8'),'../');
  const cssTarget=await emit(`build/styles.${fingerprint(css)}.css`,css);
  produced.set('styles.css',cssTarget);
  await writeFile(path.join(output,'styles.css'),replaceAssets(await readFile(path.join(source,'styles.css'),'utf8'),'./'));
  for(const name of ['index.html','404.html']) {
    let html=replaceAssets(await readFile(path.join(source,name),'utf8'),'./');
    html=html.replace(/(src|href)=(['"])(\.?\/?[\w-]+\.(?:mjs|css))(?:\?[^'"]*)?\2/g,(match,attribute,quote,url)=>{
      const target=produced.get(url.replace(/^\.\//,'').replace(/^\//,''));
      if(!target)throw new Error(`Unmapped page resource: ${url}`);
      return `${attribute}=${quote}${url.startsWith('/')?'/':'./'}${target}${quote}`;
    });
    await writeFile(path.join(output,name),html);
  }
  await writeFile(path.join(output,'_headers'),await readFile(path.join(source,'_headers')));
  await writeFile(path.join(output,'_redirects'),[...legacy].sort().map(([from,to])=>`${from} ${to} 301`).join('\n')+'\n');
  // Old-name files become stable redirects, so deploy output does not duplicate all images and audio.
  for(const name of await readdir(path.join(output,'assets'))) {
    if(name!=='content')await rm(path.join(output,'assets',name));
  }
  const manifest={schema:1,hash:'SHA-256/80',entry:produced.get('app.mjs'),
    files:Object.fromEntries([...produced].filter(([name,value])=>name.startsWith('build/') || name.startsWith('assets/content/')))};
  await writeFile(path.join(output,'build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const manifest=await build();
  console.log(JSON.stringify({entry:manifest.entry,fingerprintedFiles:Object.keys(manifest.files).length}));
}
