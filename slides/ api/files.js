// api/files.js
export const config = { api: { bodyParser: false } };

const GH_API = 'https://api.github.com';
const {
  GITHUB_TOKEN,
  GH_OWNER = 'tngon462',
  GH_REPO  = 'slide',
  GH_BRANCH = 'main',
  IMAGE_DIR = 'slides',
  MANIFEST_PATH = 'slides/manifest.json'
} = process.env;

const ALLOWED_EXT = ['.jpg','.jpeg','.png','.gif','.webp','.bmp','.avif','.svg'];

function toBase64(buf){ return Buffer.from(buf).toString('base64'); }
function sanitizeName(name){
  return name
    .replace(/^\s+|\s+$/g,'')
    .replace(/[\/\\:*?"<>|]+/g, '-') // cấm ký tự nguy hiểm
    .replace(/\s+/g,'-')
    .replace(/-+/g,'-');
}
function extOf(n){ const m = n.toLowerCase().match(/\.[a-z0-9]+$/); return m?m[0]:''; }
function isImageName(n){ return ALLOWED_EXT.includes(extOf(n)); }

async function gh(path, init={}){
  const res = await fetch(`${GH_API}${path}`, {
    ...init,
    headers:{
      'Authorization':`Bearer ${GITHUB_TOKEN}`,
      'Accept':'application/vnd.github+json',
      'User-Agent':'slides-admin',
      ...(init.headers||{})
    }
  });
  if(!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${t}`);
  }
  return res;
}

async function getDirImages(){
  const r = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(IMAGE_DIR)}?ref=${encodeURIComponent(GH_BRANCH)}`);
  const arr = await r.json();
  const files = (Array.isArray(arr)?arr:[]).filter(x => x.type==='file' && isImageName(x.name));
  return files.map(f => ({
    name: f.name,
    path: f.path,
    sha: f.sha,
    size: f.size,
    download_url: f.download_url
  })).sort((a,b)=> a.name.localeCompare(b.name, 'en', {numeric:true}));
}

async function getFile(path){
  const r = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`);
  return r.json();
}

async function putFile(path, contentBase64, message, sha){
  const body = { message, content: contentBase64, branch: GH_BRANCH };
  if(sha) body.sha = sha;
  const r = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method:'PUT', body: JSON.stringify(body)
  });
  return r.json();
}

async function deleteFile(path, sha){
  const r = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method:'DELETE',
    body: JSON.stringify({ message:`chore(slides): delete ${path}`, sha, branch: GH_BRANCH })
  });
  return r.json();
}

async function ensureUniqueName(desired){
  // nếu chưa tồn tại -> ok
  try{
    await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(`${IMAGE_DIR}/${desired}`)}?ref=${encodeURIComponent(GH_BRANCH)}`);
  }catch(e){
    if(String(e.message).includes('404')) return desired; // chưa có
    throw e;
  }
  const base = desired.replace(/\.[^/.]+$/,'');
  const ex = extOf(desired);
  for (let i=1;i<=999;i++){
    const candidate = `${base}-${i}${ex}`;
    try{
      await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(`${IMAGE_DIR}/${candidate}`)}?ref=${encodeURIComponent(GH_BRANCH)}`);
    }catch(e){
      if(String(e.message).includes('404')) return candidate;
      throw e;
    }
  }
  throw new Error('Không tạo được tên file duy nhất');
}

async function rebuildManifest(){
  const files = await getDirImages();
  const arr = files.map(f => f.path); // manifest: mảng chuỗi
  const content = toBase64(Buffer.from(JSON.stringify(arr, null, 2), 'utf8'));
  let oldSha = null;
  try{ const mf = await getFile(MANIFEST_PATH); oldSha = mf.sha; }catch(e){}
  const out = await putFile(MANIFEST_PATH, content, `chore(manifest): rebuild (${arr.length} items)`, oldSha);
  return { manifestCount: arr.length, manifestSha: out.commit.sha };
}

async function parseForm(req){
  const contentType = req.headers['content-type'] || '';
  const buf = await new Promise((ok,err)=>{
    const chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>ok(Buffer.concat(chunks))); req.on('error',err);
  });
  if (req.method === 'POST') {
    const fd = await new Response(buf, { headers: { 'Content-Type': contentType } }).formData();
    const images = fd.getAll('images');
    return { images };
  } else {
    const text = buf.toString('utf8') || '{}';
    return JSON.parse(text);
  }
}

export default async function handler(req, res){
  try{
    if (!GITHUB_TOKEN) { res.status(500).json({ error: 'Thiếu GITHUB_TOKEN' }); return; }

    if (req.method === 'GET') {
      const items = await getDirImages();
      res.status(200).json({ items }); return;
    }

    if (req.method === 'POST') {
      const { images } = await parseForm(req);
      if(!images?.length){ res.status(400).json({ error: 'Chưa có ảnh' }); return; }

      let added = 0;
      for (const f of images){
        if(!f || !f.name) continue;
        let clean = sanitizeName(f.name);
        if (!isImageName(clean)) { res.status(400).json({ error: `File không hỗ trợ: ${f.name}` }); return; }
        clean = await ensureUniqueName(clean);
        const buf = Buffer.from(await f.arrayBuffer());
        await putFile(`${IMAGE_DIR}/${clean}`, toBase64(buf), `chore(slides): add ${clean}`);
        added++;
      }
      const { manifestCount } = await rebuildManifest();
      res.status(200).json({ added, manifestCount }); return;
    }

    if (req.method === 'PUT') {
      const { old_path, new_name } = await parseForm(req);
      if(!old_path || !new_name){ res.status(400).json({ error: 'Thiếu old_path hoặc new_name' }); return; }

      const file = await getFile(old_path);
      const origExt = extOf(old_path);
      let desired = sanitizeName(new_name);
      if (!extOf(desired)) desired += origExt;
      if (!isImageName(desired)) { res.status(400).json({ error: 'Tên mới không đúng định dạng ảnh' }); return; }
      desired = await ensureUniqueName(desired);

      // tạo file mới với cùng nội dung
      const contentB64 = file.content;
      await putFile(`${IMAGE_DIR}/${desired}`, contentB64, `chore(slides): rename ${old_path.split('/').pop()} -> ${desired}`);
      // xóa file cũ
      await deleteFile(old_path, file.sha);

      const { manifestCount } = await rebuildManifest();
      res.status(200).json({ old: old_path, new: `${IMAGE_DIR}/${desired}`, manifestCount }); return;
    }

    if (req.method === 'DELETE') {
      const { path } = await parseForm(req);
      if(!path){ res.status(400).json({ error: 'Thiếu path' }); return; }
      const info = await getFile(path);
      await deleteFile(path, info.sha);
      const { manifestCount } = await rebuildManifest();
      res.status(200).json({ removed: 1, manifestCount }); return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
}
