// api/manifest.js
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
function extOf(n){ const m = n.toLowerCase().match(/\.[a-z0-9]+$/); return m?m[0]:''; }
function isImageName(n){ return ALLOWED_EXT.includes(extOf(n)); }
function toBase64(buf){ return Buffer.from(buf).toString('base64'); }

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
  return (Array.isArray(arr)?arr:[])
    .filter(x => x.type==='file' && isImageName(x.name))
    .map(f => ({ path: f.path, name: f.name }))
    .sort((a,b)=> a.name.localeCompare(b.name, 'en', {numeric:true}));
}

async function getManifest(){
  const r = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(MANIFEST_PATH)}?ref=${encodeURIComponent(GH_BRANCH)}`);
  const f = await r.json();
  const content = Buffer.from(f.content, f.encoding).toString('utf8');
  return { json: JSON.parse(content), sha: f.sha };
}

async function putManifest(paths, prevSha){
  const content = JSON.stringify(paths, null, 2);
  const r = await gh(`/repos/${GH_OWNER}/${GH_REPO}/contents/${encodeURIComponent(MANIFEST_PATH)}`,{
    method:'PUT',
    body: JSON.stringify({
      message:`chore(manifest): rebuild (${paths.length} items)`,
      content: toBase64(Buffer.from(content,'utf8')),
      branch: GH_BRANCH,
      sha: prevSha || undefined
    })
  });
  return r.json();
}

export default async function handler(req,res){
  try{
    if(!GITHUB_TOKEN){ res.status(500).json({ error:'Thiếu GITHUB_TOKEN' }); return; }

    if(req.method === 'GET'){
      try{
        const mf = await getManifest();
        res.status(200).json({ items: mf.json, sha: mf.sha });
      }catch(e){
        if(String(e.message).includes('404')){ res.status(200).json({ items: [], sha: null }); }
        else throw e;
      }
      return;
    }

    if(req.method === 'POST'){
      const files = await getDirImages();
      let prevSha = null;
      try{ prevSha = (await getManifest()).sha; }catch(e){}
      const out = await putManifest(files.map(f=>f.path), prevSha);
      res.status(200).json({ manifestCount: files.length, commitSha: out.commit.sha });
      return;
    }

    res.status(405).json({ error:'Method not allowed' });
  }catch(e){
    res.status(500).json({ error: e.message });
  }
}
