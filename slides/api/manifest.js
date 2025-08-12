// api/add-slides.js
export const config = { api: { bodyParser: false } };

const GH_API = 'https://api.github.com';
const {
  GITHUB_TOKEN,
  GH_OWNER = 'tngon462',
  GH_REPO = 'slide',
  GH_BRANCH = 'main',
  IMAGE_DIR = 'slides',
  MANIFEST_PATH = 'slides/manifest.json'
} = process.env;

function toBase64(buf){ return Buffer.from(buf).toString('base64'); }
function sanitizeName(name){
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}

async function parseForm(req){
  const contentType = req.headers['content-type'] || '';
  const buf = await new Promise((ok,err)=>{
    const chunks=[]; req.on('data',c=>chunks.push(c)); req.on('end',()=>ok(Buffer.concat(chunks))); req.on('error',err);
  });
  const fd = await new Response(buf, { headers: { 'Content-Type': contentType } }).formData();
  const images = fd.getAll('images');
  const durations = fd.getAll('durations').map(x=> Number(x||8));
  const alts = fd.getAll('alts').map(String);
  return { images, durations, alts };
}

async function gh(path, init={}){
  const res = await fetch(`${GH_API}${path}`, {
    ...init,
    headers:{
      'Authorization':`Bearer ${GITHUB_TOKEN}`,
      'Accept':'application/vnd.github+json',
      'User-Agent':'slides-manager',
      ...(init.headers||{})
    }
  });
  if(!res.ok){
    throw new Error(`GitHub ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res;
}

async function getFile(path, branch){
  try{
    const res = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`);
    return await res.json();
  }catch(e){
    if(String(e.message).includes('404')) return null;
    throw e;
  }
}

async function putFile(path, branch, contentBase64, message, sha){
  const body = { message, content: contentBase64, branch };
  if(sha) body.sha = sha;
  const res = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method:'PUT',
    body: JSON.stringify(body)
  });
  return res.json(); // {commit:{sha}, content:{...}}
}

function normalizeToObjects(manifest){
  // manifest có thể là mảng string, mảng object, hoặc {slides:[...]}
  const arr = Array.isArray(manifest) ? manifest
            : (Array.isArray(manifest?.slides) ? manifest.slides : []);
  return arr.map(x => typeof x === 'string' ? ({src:x}) : ({...x}));
}

export default async function handler(req,res){
  try{
    if(req.method !== 'POST') { res.status(405).json({error:'Method not allowed'}); return; }
    if(!GITHUB_TOKEN) { res.status(500).json({error:'Thiếu GITHUB_TOKEN'}); return; }

    const { images, durations, alts } = await parseForm(req);
    if(!images.length) { res.status(400).json({error:'Chưa có ảnh'}); return; }

    // 1) Lấy manifest hiện tại (nếu chưa có -> rỗng)
    const mfFile = await getFile(MANIFEST_PATH, GH_BRANCH);
    let manifest = mfFile ? JSON.parse(Buffer.from(mfFile.content, mfFile.encoding).toString('utf8')) : [];
    let mfSha = mfFile?.sha || null;
    let items = normalizeToObjects(manifest);

    // 2) Upload từng ảnh + thêm vào items
    const now = new Date().toISOString().replace(/[:.]/g,'').replace('T','_').slice(0,15);
    let added = 0;
    for (let i=0;i<images.length;i++){
      const file = images[i];
      if(!file || !file.name || !file.stream) continue;

      const buf = Buffer.from(await file.arrayBuffer());
      const imageName = `${now}_${i+1}_${sanitizeName(file.name)}`;
      const imagePath = `${IMAGE_DIR.replace(/\/+$/,'')}/${imageName}`;

      await putFile(imagePath, GH_BRANCH, toBase64(buf), `chore(slides): add ${imageName}`);
      // tránh trùng (theo src)
      if(!items.some(x => x.src === imagePath)){
        const dur = Number.isFinite(durations[i]) ? durations[i] : 8;
        const alt = (alts[i]||'').trim();
        const obj = { src: imagePath, duration: dur };
        if (alt) obj.alt = alt;
        items.push(obj);
        added++;
      }
    }

    // 3) Ghi manifest (luôn ghi dạng mảng object cho đồng nhất)
    const content = JSON.stringify(items, null, 2);
    const out = await putFile(MANIFEST_PATH, GH_BRANCH, toBase64(Buffer.from(content,'utf8')),
                              `chore(manifest): append ${added} slide(s)`, mfSha);

    res.status(200).json({ added, commitSha: out.commit.sha });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
}
