// search-view.jsx — PR Search view (lo-fi but considered)
function SearchView({ onOpenPR }) {
  const [q, setQ] = React.useState("");
  const [scope, setScope] = React.useState("all");
  const inputRef = React.useRef(null);

  React.useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = SAMPLE_PRS.filter(pr => {
    if (scope === "yours" && !pr.youReviewed) return false;
    if (scope === "open" && pr.status !== "open") return false;
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return pr.title.toLowerCase().includes(s)
        || pr.repo.toLowerCase().includes(s)
        || pr.author.handle.toLowerCase().includes(s)
        || String(pr.id).includes(s)
        || pr.branch.toLowerCase().includes(s);
  });

  return (
    <div style={{flex:1, overflow:'auto', background:'var(--bg)'}}>
      <div style={{maxWidth:880, margin:'0 auto', padding:'56px 32px 80px'}}>

        <div style={{textAlign:'left', marginBottom:28}}>
          <div style={{fontSize:11, fontWeight:600, color:'var(--ink-3)', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:8}}>Open a Pull Request</div>
          <h1 style={{fontFamily:'var(--font-display)', fontSize:32, fontWeight:600, letterSpacing:'-0.025em', margin:0, lineHeight:1.1}}>
            Find anything in seconds.
          </h1>
          <div style={{color:'var(--ink-3)', fontSize:14, marginTop:8, maxWidth:520, lineHeight:1.5}}>
            Type a number, branch fragment, author or any word from the title. Use <span className="kbd">/</span> to focus, <span className="kbd">↵</span> to open.
          </div>
        </div>

        {/* search field */}
        <div style={{
          display:'flex', alignItems:'center', gap:10,
          height:48, padding:'0 14px',
          background:'var(--bg-elev)', border:'1px solid var(--line-strong)',
          borderRadius:10, boxShadow:'0 1px 0 rgba(0,0,0,0.02), 0 8px 24px -12px rgba(0,0,0,0.08)',
        }}>
          <IconSearch style={{color:'var(--ink-3)', width:16, height:16}}/>
          <input
            ref={inputRef}
            value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search PRs by #number, branch, author, or title…"
            style={{flex:1, border:'none', outline:'none', background:'transparent', fontSize:15, color:'var(--ink)', fontFamily:'var(--font-ui)'}}/>
          <span className="kbd">⌘K</span>
        </div>

        {/* scope tabs */}
        <div style={{display:'flex', gap:4, marginTop:22, alignItems:'center'}}>
          {[
            {k:"all", l:"All open", n: SAMPLE_PRS.filter(p=>p.status==='open').length},
            {k:"yours", l:"You've reviewed", n: SAMPLE_PRS.filter(p=>p.youReviewed).length},
            {k:"open", l:"Awaiting your review", n: 2},
          ].map(t => (
            <button key={t.k} onClick={()=>setScope(t.k)} className={"subtab" + (scope===t.k?' active':'')}>
              {t.l} <span style={{color:'var(--ink-4)', fontFamily:'var(--font-mono)', fontSize:11}}>{t.n}</span>
            </button>
          ))}
          <div style={{flex:1}}/>
          <button className="iconbtn" title="Filter"><IconFilter/></button>
        </div>

        {/* results */}
        <div style={{marginTop:14, border:'1px solid var(--line)', borderRadius:10, background:'var(--bg-elev)', overflow:'hidden'}}>
          {filtered.length === 0 && (
            <div style={{padding:'48px 16px', textAlign:'center', color:'var(--ink-3)', fontSize:13}}>No PRs match.</div>
          )}
          {filtered.map((pr, i) => (
            <SearchRow key={pr.id} pr={pr} onOpen={()=>onOpenPR(pr)} divide={i!==0}/>
          ))}
        </div>

        {/* recent repos */}
        <div style={{marginTop:36}}>
          <div style={{fontSize:11, fontWeight:600, color:'var(--ink-3)', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:10}}>Recent repos</div>
          <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(220px, 1fr))', gap:10}}>
            {RECENT_REPOS.map(r => (
              <div key={r.name} style={{
                padding:14, border:'1px solid var(--line)', borderRadius:10,
                background:'var(--bg-elev)',
              }}>
                <div className="mono" style={{fontSize:12, fontWeight:600, color:'var(--ink)'}}>{r.name}</div>
                <div style={{fontSize:12, color:'var(--ink-3)', marginTop:4, lineHeight:1.4}}>{r.desc}</div>
                <div style={{fontSize:11, color:'var(--ink-4)', marginTop:8, fontFamily:'var(--font-mono)'}}>{r.prs} open PRs</div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

function SearchRow({pr, onOpen, divide}) {
  const stateChip = {
    'approved-1-of-2': <span className="chip add"><span className="dot"/>1 of 2 approvals</span>,
    'needs-review':    <span className="chip"><span className="dot" style={{background:'var(--ink-4)'}}/>Needs review</span>,
    'changes-requested': <span className="chip warn"><span className="dot"/>Changes requested</span>,
    'draft':           <span className="chip">Draft</span>,
    'merged':          <span className="chip accent">Merged</span>,
  }[pr.reviewState];

  return (
    <div onClick={onOpen} style={{
      display:'grid',
      gridTemplateColumns: '36px 1fr auto',
      gap:14, padding:'12px 16px',
      borderTop: divide ? '1px solid var(--line-2)' : 'none',
      cursor:'default',
    }}
    onMouseEnter={e=>e.currentTarget.style.background='var(--bg-soft)'}
    onMouseLeave={e=>e.currentTarget.style.background=''}>
      <div style={{display:'flex', alignItems:'flex-start', paddingTop:2}}>
        <span className="avatar" style={{background: pr.author.color, color:'oklch(0.25 0.05 270)'}}>{pr.author.initials}</span>
      </div>
      <div style={{minWidth:0}}>
        <div style={{display:'flex', alignItems:'center', gap:8, flexWrap:'wrap'}}>
          <span className="mono" style={{fontSize:12, color:'var(--ink-3)', fontWeight:500}}>#{pr.id}</span>
          <span style={{fontSize:13, fontWeight:500, color:'var(--ink)'}} className="ellipsis">{pr.title}</span>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:10, marginTop:6, fontSize:11.5, color:'var(--ink-3)'}}>
          <span className="mono">{pr.repo}</span>
          <span style={{color:'var(--ink-4)'}}>·</span>
          <span className="mono" style={{color:'var(--ink-3)'}}>{pr.branch}</span>
          <span style={{color:'var(--ink-4)'}}>·</span>
          <span>by {pr.author.handle}</span>
          <span style={{color:'var(--ink-4)'}}>·</span>
          <span>{pr.updated}</span>
        </div>
      </div>
      <div style={{display:'flex', alignItems:'center', gap:10}}>
        <span className="mono" style={{fontSize:11.5}}>
          <span style={{color:'var(--add)'}}>+{pr.plus}</span>{' '}
          <span style={{color:'var(--del)'}}>−{pr.minus}</span>
        </span>
        {stateChip}
      </div>
    </div>
  );
}

Object.assign(window, { SearchView });
