// editor-view.jsx — Code editor (lo-fi but plausible)
function EditorView({ pr }) {
  const [activeFile, setActiveFile] = React.useState('api/stream/permit.rs');

  const tree = [
    { type:'folder', name:'api', open:true, children:[
      { type:'folder', name:'cache', open:true, children:[
        { type:'file', name:'mod.rs', path:'api/cache/mod.rs' },
        { type:'file', name:'ring.rs', path:'api/cache/ring.rs', mod:true },
      ]},
      { type:'folder', name:'stream', open:true, children:[
        { type:'file', name:'mod.rs', path:'api/stream/mod.rs' },
        { type:'file', name:'permit.rs', path:'api/stream/permit.rs', mod:true },
        { type:'file', name:'producer.rs', path:'api/stream/producer.rs' },
      ]},
      { type:'folder', name:'handlers', children:[]},
    ]},
    { type:'folder', name:'config', children:[]},
    { type:'folder', name:'tests', children:[]},
    { type:'file', name:'Cargo.toml' },
    { type:'file', name:'README.md' },
  ];

  const fileSrc = `use std::sync::Arc;
use tokio::sync::Notify;

/// RAII handle: holding one means the cache has reserved
/// \`bytes\` for this writer.
pub struct StreamPermit {
    bytes: usize,
    cache: Arc<RingCache>,
}

impl StreamPermit {
    pub async fn reserve(cache: Arc<RingCache>, bytes: usize) -> Self {
        loop {
            if cache.try_reserve(bytes) {
                return Self { bytes, cache };
            }
            cache.pressure.notified().await;
        }
    }

    pub fn tier(&self) -> StreamTier {
        if self.cache.elapsed_since(self.created_at) > Duration::from_secs(5) {
            StreamTier::Long
        } else {
            StreamTier::Short
        }
    }
}

impl Drop for StreamPermit {
    fn drop(&mut self) {
        self.cache.release(self.bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn drop_releases_bytes() {
        let cache = Arc::new(RingCache::new(1024));
        {
            let _p = StreamPermit::reserve(cache.clone(), 256).await;
            assert_eq!(cache.available(), 768);
        }
        assert_eq!(cache.available(), 1024);
    }
}`;

  return (
    <div style={{flex:1, display:'flex', minHeight:0, background:'var(--bg)'}}>
      {/* file tree */}
      <div style={{width:240, borderRight:'1px solid var(--line)', background:'var(--bg-soft)', display:'flex', flexDirection:'column', flexShrink:0}}>
        <div style={{padding:'8px 12px', borderBottom:'1px solid var(--line-2)', display:'flex', alignItems:'center', gap:8}}>
          <span className="mono" style={{fontSize:11, color:'var(--ink-3)', flex:1}}>{pr.repo}</span>
          <button className="iconbtn" style={{width:20, height:20}}><IconPlus/></button>
        </div>
        <div className="scroll" style={{flex:1, padding:'6px 0'}}>
          <Tree nodes={tree} activeFile={activeFile} setActive={setActiveFile} depth={0}/>
        </div>
      </div>

      {/* editor */}
      <div style={{flex:1, display:'flex', flexDirection:'column', minWidth:0}}>
        {/* editor tabs */}
        <div style={{display:'flex', background:'var(--bg-soft)', borderBottom:'1px solid var(--line)', height:32, flexShrink:0}}>
          {['api/stream/permit.rs', 'api/cache/ring.rs'].map(f => (
            <div key={f} onClick={()=>setActiveFile(f)} style={{
              display:'inline-flex', alignItems:'center', gap:6,
              padding:'0 12px', height:'100%',
              background: activeFile===f ? 'var(--bg)' : 'transparent',
              borderRight:'1px solid var(--line)',
              fontSize:11.5, color: activeFile===f ? 'var(--ink)' : 'var(--ink-3)',
            }}>
              <IconFile style={{width:11, height:11, color: f.includes('permit') ? 'oklch(0.65 0.13 30)' : 'oklch(0.65 0.13 200)'}}/>
              <span className="mono">{f.split('/').pop()}</span>
              <IconClose style={{width:10, height:10, color:'var(--ink-4)', marginLeft:4}}/>
            </div>
          ))}
          <span style={{flex:1}}/>
          <div style={{display:'flex', alignItems:'center', gap:6, padding:'0 12px', fontSize:11, color:'var(--ink-3)'}}>
            <span className="chip" style={{height:18, fontSize:10}}>Rust</span>
            <span className="mono">UTF-8</span>
            <span className="mono">LF</span>
          </div>
        </div>

        {/* breadcrumb */}
        <div style={{padding:'6px 14px', fontSize:11, color:'var(--ink-3)', borderBottom:'1px solid var(--line-2)', background:'var(--bg)', display:'flex', alignItems:'center', gap:6}}>
          {activeFile.split('/').map((p, i, arr) => (
            <React.Fragment key={i}>
              <span className="mono" style={{color: i===arr.length-1 ? 'var(--ink-2)' : 'var(--ink-3)'}}>{p}</span>
              {i < arr.length-1 && <IconChevR style={{width:10, height:10, color:'var(--ink-4)'}}/>}
            </React.Fragment>
          ))}
          <span style={{flex:1}}/>
          <span className="mono" style={{color:'var(--ink-4)'}}>Ln 12, Col 28</span>
        </div>

        {/* code area */}
        <div className="scroll" style={{flex:1, background:'var(--bg)'}}>
          <div className="mono" style={{fontSize:12.5, lineHeight:1.65, padding:'14px 0'}}>
            {fileSrc.split('\n').map((line, i) => (
              <div key={i} style={{display:'grid', gridTemplateColumns:'48px 1fr', position:'relative'}}>
                <div style={{textAlign:'right', padding:'0 12px 0 0', color:'var(--ink-4)', fontSize:11, userSelect:'none'}}>{i+1}</div>
                <div style={{padding:'0 16px', color:'var(--ink)'}}>
                  <SyntaxLine c={line || ' '}/>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* status bar */}
        <div style={{height:22, background:'var(--bg-tab)', borderTop:'1px solid var(--line)', display:'flex', alignItems:'center', gap:14, padding:'0 12px', fontSize:10.5, color:'var(--ink-3)', flexShrink:0}}>
          <span className="mono" style={{display:'inline-flex', alignItems:'center', gap:4}}><IconBranch style={{width:10, height:10}}/>{pr.branch}</span>
          <span className="mono">main ↓</span>
          <span style={{flex:1}}/>
          <span className="mono">Rust analyzer ●</span>
          <span className="mono">UTF-8</span>
          <span className="mono">spaces: 4</span>
        </div>
      </div>

      {/* right panel — context for AI */}
      <div style={{width:260, borderLeft:'1px solid var(--line)', background:'var(--bg-soft)', flexShrink:0, padding:'14px 14px', display:'flex', flexDirection:'column', gap:14}}>
        <div>
          <div style={{fontSize:11, fontWeight:600, color:'var(--ink-3)', letterSpacing:'0.04em', textTransform:'uppercase', marginBottom:8, display:'flex', alignItems:'center', gap:6}}>
            <IconSparkle style={{width:11, height:11, color:'var(--accent)'}}/> In this PR
          </div>
          <div style={{fontSize:12, color:'var(--ink-2)', lineHeight:1.55}}>
            This file is <strong>new</strong> in PR #{pr.id}. Used in <span className="mono" style={{fontSize:11, background:'var(--bg)', padding:'1px 5px', border:'1px solid var(--line)', borderRadius:4}}>cache/mod.rs</span> and <span className="mono" style={{fontSize:11, background:'var(--bg)', padding:'1px 5px', border:'1px solid var(--line)', borderRadius:4}}>stream/producer.rs</span>.
          </div>
        </div>
        <div>
          <div style={{fontSize:11, fontWeight:600, color:'var(--ink-3)', letterSpacing:'0.04em', textTransform:'uppercase', marginBottom:8}}>Outline</div>
          <div style={{fontSize:11.5, color:'var(--ink-2)', display:'flex', flexDirection:'column', gap:3}}>
            <div className="mono" style={{padding:'2px 0'}}>struct StreamPermit</div>
            <div className="mono" style={{padding:'2px 0', paddingLeft:12, color:'var(--ink-3)'}}>impl StreamPermit</div>
            <div className="mono" style={{padding:'2px 0', paddingLeft:24, color:'var(--accent)'}}>fn reserve()</div>
            <div className="mono" style={{padding:'2px 0', paddingLeft:24, color:'var(--ink-3)'}}>fn tier()</div>
            <div className="mono" style={{padding:'2px 0', paddingLeft:12, color:'var(--ink-3)'}}>impl Drop</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tree({nodes, activeFile, setActive, depth}) {
  return (
    <>
      {nodes.map((n, i) => (
        <TreeNode key={i} n={n} depth={depth} activeFile={activeFile} setActive={setActive}/>
      ))}
    </>
  );
}

function TreeNode({n, depth, activeFile, setActive}) {
  const [open, setOpen] = React.useState(n.open !== false);
  if (n.type === 'folder') {
    return (
      <>
        <div onClick={()=>setOpen(!open)} style={{
          display:'flex', alignItems:'center', gap:5,
          padding: '2px ' + (8 + depth*10) + 'px',
          fontSize:11.5, color:'var(--ink-2)', cursor:'default',
        }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg)'} onMouseLeave={e=>e.currentTarget.style.background=''}>
          {open ? <IconChevD style={{width:10, height:10, color:'var(--ink-4)'}}/> : <IconChevR style={{width:10, height:10, color:'var(--ink-4)'}}/>}
          <IconFolder style={{width:12, height:12, color:'oklch(0.7 0.08 75)'}}/>
          <span className="mono">{n.name}</span>
        </div>
        {open && n.children && <Tree nodes={n.children} activeFile={activeFile} setActive={setActive} depth={depth+1}/>}
      </>
    );
  }
  return (
    <div onClick={()=>n.path && setActive(n.path)} style={{
      display:'flex', alignItems:'center', gap:5,
      padding: '2px ' + (8 + depth*10) + 'px',
      paddingLeft: 8 + depth*10 + 14,
      fontSize:11.5,
      color: activeFile===n.path ? 'var(--ink)' : 'var(--ink-2)',
      background: activeFile===n.path ? 'var(--bg-elev)' : 'transparent',
      cursor:'default',
    }} onMouseEnter={e=>{ if(activeFile!==n.path) e.currentTarget.style.background='var(--bg)'}} onMouseLeave={e=>{ if(activeFile!==n.path) e.currentTarget.style.background=''}}>
      <IconFile style={{width:11, height:11, color:'var(--ink-4)'}}/>
      <span className="mono" style={{flex:1}}>{n.name}</span>
      {n.mod && <span style={{width:5, height:5, borderRadius:'50%', background:'var(--warn)'}}/>}
    </div>
  );
}

Object.assign(window, { EditorView });
