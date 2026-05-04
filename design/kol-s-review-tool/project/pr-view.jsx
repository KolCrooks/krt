// pr-view.jsx — PR View mode (description + comments + reviewers)
function PRView({ pr, onSwitchMode }) {
  return (
    <div style={{flex:1, overflow:'auto', background:'var(--bg)'}}>
      <div style={{maxWidth:1080, margin:'0 auto', padding:'24px 28px 80px', display:'grid', gridTemplateColumns:'1fr 280px', gap:28}}>

        {/* main column */}
        <div style={{minWidth:0}}>

          {/* header */}
          <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6}}>
            <span className="mono" style={{fontSize:12, color:'var(--ink-3)'}}>{pr.repo} #{pr.id}</span>
            <span className="chip add" style={{height:22}}><span className="dot"/>Open</span>
          </div>
          <h1 style={{fontFamily:'var(--font-display)', fontSize:26, fontWeight:600, letterSpacing:'-0.02em', margin:'4px 0 14px', lineHeight:1.2, textWrap:'pretty'}}>
            {pr.title}
          </h1>
          <div style={{display:'flex', alignItems:'center', gap:10, fontSize:12.5, color:'var(--ink-3)'}}>
            <span className="avatar s" style={{background: pr.author.color, color:'oklch(0.25 0.05 270)'}}>{pr.author.initials}</span>
            <span style={{color:'var(--ink-2)', fontWeight:500}}>{pr.author.handle}</span>
            <span className="mono" style={{padding:'2px 7px', border:'1px solid var(--line)', borderRadius:5, fontSize:11, color:'var(--ink-2)'}}>{pr.branch}</span>
            <span>→</span>
            <span className="mono" style={{padding:'2px 7px', border:'1px solid var(--line)', borderRadius:5, fontSize:11, color:'var(--ink-2)'}}>{pr.base}</span>
            <span style={{flex:1}}/>
            <span className="mono">+{pr.plus} −{pr.minus} · {Array.isArray(pr.files) ? pr.files.length : pr.files} files</span>
          </div>

          {/* description card */}
          <div style={{marginTop:20, border:'1px solid var(--line)', borderRadius:10, background:'var(--bg-elev)', overflow:'hidden'}}>
            <div style={{padding:'10px 14px', borderBottom:'1px solid var(--line-2)', display:'flex', alignItems:'center', gap:8, fontSize:12, color:'var(--ink-3)'}}>
              <IconBook style={{width:13, height:13}}/>
              <span style={{fontWeight:500, color:'var(--ink-2)'}}>Description</span>
              <span style={{flex:1}}/>
              <button className="btn" style={{height:24, fontSize:11, padding:'0 8px'}}>
                <IconSparkle style={{width:11, height:11}}/>Open Tour
              </button>
            </div>
            <Markdown body={pr.body}/>
          </div>

          {/* timeline / comments / automation */}
          <ActivitySection pr={pr}/>

          {/* reply box */}
          <div style={{marginTop:18, padding:14, border:'1px solid var(--line)', borderRadius:10, background:'var(--bg-elev)'}}>
            <textarea placeholder="Leave a comment…" rows={3}
              style={{width:'100%', border:'none', outline:'none', fontFamily:'var(--font-ui)', fontSize:13, color:'var(--ink)', background:'transparent', resize:'vertical'}}/>
            <div style={{display:'flex', gap:8, marginTop:10, alignItems:'center'}}>
              <button className="btn" style={{height:26, fontSize:11.5}}>Markdown</button>
              <span style={{flex:1}}/>
              <button className="btn" style={{height:26, fontSize:11.5}}>Comment</button>
              <button className="btn primary" style={{height:26, fontSize:11.5}}>Approve</button>
            </div>
          </div>
        </div>

        {/* sidebar */}
        <div style={{minWidth:0}}>
          <SideCard title="Reviewers">
            {pr.reviewers.map(r => (
              <div key={r.name} style={{display:'flex', alignItems:'center', gap:8, padding:'5px 0', fontSize:12}}>
                <span className="avatar s">{r.initials}</span>
                <span className="mono" style={{flex:1, fontSize:11.5, color:'var(--ink-2)'}}>{r.name}</span>
                <ReviewerState s={r.state}/>
              </div>
            ))}
          </SideCard>

          <SideCard title="Checks">
            <div style={{fontSize:12, color:'var(--ink-2)'}}>
              <CheckRow ok label="ci/lint"/>
              <CheckRow ok label="ci/build"/>
              <CheckRow ok label="ci/test"/>
              <CheckRow ok label="ci/integration"/>
              <CheckRow pending label="ci/perf-bench"/>
            </div>
          </SideCard>

          <SideCard title="Labels">
            <div style={{display:'flex', flexWrap:'wrap', gap:6}}>
              {pr.labels.map(l => <span key={l} className="chip" style={{height:22, fontSize:11}}>{l}</span>)}
            </div>
          </SideCard>

          <SideCard title="Stats">
            <div style={{fontSize:12, color:'var(--ink-2)', display:'grid', gap:6}}>
              <Stat k="Commits" v={pr.commits}/>
              <Stat k="Files" v={Array.isArray(pr.files) ? pr.files.length : pr.files}/>
              <Stat k="Lines added" v={'+' + pr.plus} c="var(--add)"/>
              <Stat k="Lines removed" v={'−' + pr.minus} c="var(--del)"/>
              <Stat k="Last updated" v={pr.updated}/>
            </div>
          </SideCard>

          <button onClick={()=>onSwitchMode('review')} className="btn accent" style={{width:'100%', justifyContent:'center', marginTop:6, height:32}}>
            <IconReview/> Start review
          </button>
        </div>

      </div>
    </div>
  );
}

function SideCard({title, children}) {
  return (
    <div style={{marginBottom:14, padding:14, border:'1px solid var(--line)', borderRadius:10, background:'var(--bg-elev)'}}>
      <div style={{fontSize:11, fontWeight:600, color:'var(--ink-3)', letterSpacing:'0.04em', textTransform:'uppercase', marginBottom:10}}>{title}</div>
      {children}
    </div>
  );
}

function ReviewerState({s}) {
  const m = {
    approved: <span className="chip add" style={{height:18, fontSize:10, padding:'0 6px'}}>Approved</span>,
    commented: <span className="chip" style={{height:18, fontSize:10, padding:'0 6px'}}>Commented</span>,
    pending: <span className="chip" style={{height:18, fontSize:10, padding:'0 6px', color:'var(--ink-4)'}}>Pending</span>,
  };
  return m[s];
}

function CheckRow({label, ok, pending}) {
  const status = ok ? 'passed' : pending ? 'running' : 'failed';
  return (
    <a href={`#checks/${label}`} title={`View ${label} — ${status}`} style={{
      display:'flex', alignItems:'center', gap:8, padding:'5px 6px', margin:'0 -6px',
      fontSize:11.5, borderRadius:5, color:'inherit', textDecoration:'none',
      cursor:'pointer',
    }}
    onMouseEnter={e=>{ e.currentTarget.style.background='var(--bg-soft)'; e.currentTarget.querySelector('.cr-arrow').style.opacity='0.7'; }}
    onMouseLeave={e=>{ e.currentTarget.style.background=''; e.currentTarget.querySelector('.cr-arrow').style.opacity='0'; }}>
      <span style={{
        width:14, height:14, borderRadius:'50%',
        background: ok ? 'var(--add-bg)' : 'var(--bg-soft)',
        border: '1px solid ' + (ok ? 'var(--add-line)' : 'var(--line)'),
        display:'grid', placeItems:'center', color: ok ? 'var(--add)' : 'var(--ink-4)',
        flexShrink:0,
      }}>
        {ok && <IconCheck style={{width:9, height:9}}/>}
        {pending && <span style={{width:5, height:5, borderRadius:'50%', background:'var(--warn)'}}/>}
      </span>
      <span className="mono" style={{flex:1, color:'var(--ink-2)'}}>{label}</span>
      {pending && <span className="mono" style={{fontSize:10, color:'var(--warn)'}}>running…</span>}
      <svg className="cr-arrow" viewBox="0 0 12 12" width="10" height="10" style={{opacity:0, transition:'opacity 80ms', color:'var(--ink-3)', flexShrink:0}}>
        <path d="M4 2h6v6M10 2 3 9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      </svg>
    </a>
  );
}

function Stat({k,v,c}) {
  return (
    <div style={{display:'flex', justifyContent:'space-between', fontSize:11.5}}>
      <span style={{color:'var(--ink-3)'}}>{k}</span>
      <span className="mono" style={{color: c || 'var(--ink-2)'}}>{v}</span>
    </div>
  );
}

function Timeline({pr}) {
  return (
    <div style={{position:'relative'}}>
      <div style={{position:'absolute', left:13, top:14, bottom:14, width:1, background:'var(--line)'}}/>
      {pr.comments.map(c => <Comment key={c.id} c={c}/>)}
    </div>
  );
}

function ActivitySection({pr}) {
  const [tab, setTab] = React.useState('discussion');
  const userCount = pr.comments.length;
  const autoCount = (pr.automation || []).length;
  return (
    <div style={{marginTop:24}}>
      <div style={{display:'flex', alignItems:'baseline', gap:14, marginBottom:14, borderBottom:'1px solid var(--line)'}}>
        <span style={{fontSize:11, fontWeight:600, color:'var(--ink-3)', letterSpacing:'0.06em', textTransform:'uppercase', marginRight:6}}>Activity</span>
        <ActivityTabBtn active={tab==='discussion'} onClick={()=>setTab('discussion')} icon={<IconComment style={{width:11, height:11}}/>} label="Discussion" count={userCount}/>
        <ActivityTabBtn active={tab==='automation'} onClick={()=>setTab('automation')} icon={<IconGear style={{width:11, height:11}}/>} label="Automation" count={autoCount}/>
        <span style={{flex:1}}/>
      </div>
      {tab === 'discussion' && <Timeline pr={pr}/>}
      {tab === 'automation' && <AutomationFeed events={pr.automation || []}/>}
    </div>
  );
}

function ActivityTabBtn({active, onClick, icon, label, count}) {
  return (
    <button onClick={onClick} style={{
      background:'transparent', border:'none', padding:'6px 4px',
      marginBottom:-1,
      borderBottom: '2px solid ' + (active ? 'var(--ink)' : 'transparent'),
      display:'inline-flex', alignItems:'center', gap:6,
      fontSize:12.5, fontWeight: active ? 600 : 500,
      color: active ? 'var(--ink)' : 'var(--ink-3)',
      cursor:'pointer', fontFamily:'var(--font-ui)',
    }}>
      {icon}
      <span>{label}</span>
      <span style={{
        fontSize:10.5, padding:'1px 6px', borderRadius:8,
        background: active ? 'var(--ink)' : 'var(--bg-soft)',
        color: active ? 'var(--bg)' : 'var(--ink-3)',
        fontWeight:500, minWidth:18, textAlign:'center',
      }}>{count}</span>
    </button>
  );
}

function AutomationFeed({events}) {
  return (
    <div style={{position:'relative'}}>
      <div style={{position:'absolute', left:13, top:8, bottom:8, width:1, background:'var(--line)'}}/>
      {events.map(e => <AutomationRow key={e.id} e={e}/>)}
    </div>
  );
}

function AutomationRow({e}) {
  const meta = AUTOMATION_KIND[e.kind] || AUTOMATION_KIND.bot;
  const statusDot = e.status === 'ok' ? 'var(--add)'
                  : e.status === 'running' ? 'var(--warn)'
                  : e.status === 'failed' ? 'var(--del)'
                  : null;
  return (
    <div style={{position:'relative', paddingLeft:38, marginBottom:10, fontSize:12.5}}>
      <span style={{
        position:'absolute', left:4, top:2,
        width:21, height:21, borderRadius:'50%',
        background:'var(--bg)',
        border:'1px solid var(--line)',
        display:'grid', placeItems:'center',
        color: meta.color,
      }}>
        {meta.icon}
      </span>
      <div style={{
        border:'1px solid var(--line-2)', borderRadius:8,
        background:'var(--bg-soft)',
        padding:'7px 10px',
        display:'flex', alignItems:'center', gap:8,
      }}>
        {statusDot && (
          <span style={{
            width:8, height:8, borderRadius:'50%', flexShrink:0,
            background: statusDot,
            ...(e.status === 'running' ? {boxShadow:'0 0 0 3px oklch(0.92 0.04 75)'} : {}),
          }}/>
        )}
        <span className="mono" style={{fontSize:11, color:'var(--ink-3)', whiteSpace:'nowrap'}}>{e.actor}</span>
        <span style={{color:'var(--ink-2)', flex:1, minWidth:0, overflow:'hidden', textOverflow:'ellipsis'}}>{e.summary}</span>
        {e.detail && <span style={{fontSize:11, color:'var(--ink-4)', textWrap:'nowrap', maxWidth:280, overflow:'hidden', textOverflow:'ellipsis'}} title={e.detail}>{e.detail}</span>}
        <span style={{fontSize:11, color:'var(--ink-4)', whiteSpace:'nowrap'}}>{e.when}</span>
      </div>
    </div>
  );
}

const AUTOMATION_KIND = {
  ci:     { color:'oklch(0.55 0.13 145)', icon: <IconCheck style={{width:10, height:10}}/> },
  bot:    { color:'oklch(0.55 0.15 250)', icon: <IconReact style={{width:11, height:11}}/> },
  push:   { color:'oklch(0.5 0.12 290)',  icon: <IconBranch style={{width:11, height:11}}/> },
  label:  { color:'oklch(0.55 0.15 75)',  icon: <IconFilter style={{width:11, height:11}}/> },
  review: { color:'oklch(0.55 0.13 30)',  icon: <IconReview style={{width:11, height:11}}/> },
};

function Comment({c}) {
  return (
    <div style={{position:'relative', paddingLeft:38, marginBottom:18}}>
      <span className="avatar s" style={{position:'absolute', left:4, top:0, background: c.author.color, color:'oklch(0.25 0.05 270)'}}>
        {c.author.initials}
      </span>
      <div style={{border:'1px solid var(--line)', borderRadius:10, background:'var(--bg-elev)', overflow:'hidden'}}>
        <div style={{display:'flex', alignItems:'center', gap:8, padding:'8px 12px', background:'var(--bg-soft)', borderBottom:'1px solid var(--line-2)', fontSize:11.5}}>
          <span style={{fontWeight:500, color:'var(--ink-2)'}}>{c.author.name}</span>
          <span style={{color:'var(--ink-3)'}}>commented</span>
          <span style={{color:'var(--ink-4)'}}>·</span>
          <span style={{color:'var(--ink-3)'}}>{c.when}</span>
          {c.tour && <span className="chip accent" style={{height:18, fontSize:10, padding:'0 6px', marginLeft:4}}><IconSparkle style={{width:9, height:9}}/>Via Tour</span>}
          {c.approved && <span className="chip add" style={{height:18, fontSize:10, padding:'0 6px', marginLeft:4}}>Approved</span>}
        </div>
        <div style={{padding:'10px 12px', fontSize:13, color:'var(--ink)', lineHeight:1.55}}>{c.body}</div>
        {c.replies && c.replies.length > 0 && (
          <div style={{borderTop:'1px solid var(--line-2)', padding:'10px 12px', background:'var(--bg-soft)'}}>
            {c.replies.map(r => (
              <div key={r.id} style={{display:'flex', gap:8, alignItems:'flex-start', fontSize:12.5}}>
                <span className="avatar s" style={{background: r.author.color, color:'oklch(0.25 0.05 270)'}}>{r.author.initials}</span>
                <div style={{flex:1, minWidth:0}}>
                  <div style={{fontSize:11, color:'var(--ink-3)'}}>
                    <span style={{color:'var(--ink-2)', fontWeight:500}}>{r.author.name}</span> · {r.when}
                  </div>
                  <div style={{color:'var(--ink)', lineHeight:1.5, marginTop:2}}>{r.body}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// minimal markdown — handles ## headings, lists, **bold**, `code`, paragraphs
function Markdown({body}) {
  const blocks = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    if (ln.startsWith('## ')) {
      blocks.push({type:'h2', text: ln.slice(3)});
      i++; continue;
    }
    if (/^\d+\.\s/.test(ln)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s/, '')); i++; }
      blocks.push({type:'ol', items});
      continue;
    }
    if (ln.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) { items.push(lines[i].slice(2)); i++; }
      blocks.push({type:'ul', items});
      continue;
    }
    // paragraph
    let p = ln;
    i++;
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('## ') && !lines[i].startsWith('- ') && !/^\d+\.\s/.test(lines[i])) {
      p += ' ' + lines[i]; i++;
    }
    blocks.push({type:'p', text: p});
  }
  const inline = (s) => {
    const out = [];
    let rest = s;
    let key = 0;
    const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
    let last = 0; let m;
    while ((m = re.exec(rest))) {
      if (m.index > last) out.push(rest.slice(last, m.index));
      if (m[1]) out.push(<strong key={key++} style={{fontWeight:600, color:'var(--ink)'}}>{m[1]}</strong>);
      else out.push(<code key={key++} className="mono" style={{fontSize:'0.92em', background:'var(--bg-soft)', padding:'1px 5px', border:'1px solid var(--line)', borderRadius:4, color:'var(--accent)'}}>{m[2]}</code>);
      last = m.index + m[0].length;
    }
    if (last < rest.length) out.push(rest.slice(last));
    return out;
  };
  return (
    <div style={{padding:'18px 20px', fontSize:13.5, color:'var(--ink-2)', lineHeight:1.65}}>
      {blocks.map((b, k) => {
        if (b.type==='h2') return <h2 key={k} style={{fontFamily:'var(--font-display)', fontSize:16, fontWeight:600, color:'var(--ink)', margin:'16px 0 8px', letterSpacing:'-0.01em'}}>{b.text}</h2>;
        if (b.type==='p')  return <p key={k} style={{margin:'0 0 12px'}}>{inline(b.text)}</p>;
        if (b.type==='ul') return <ul key={k} style={{margin:'0 0 12px', paddingLeft:18}}>{b.items.map((it,j)=><li key={j} style={{margin:'4px 0'}}>{inline(it)}</li>)}</ul>;
        if (b.type==='ol') return <ol key={k} style={{margin:'0 0 12px', paddingLeft:20}}>{b.items.map((it,j)=><li key={j} style={{margin:'4px 0'}}>{inline(it)}</li>)}</ol>;
      })}
    </div>
  );
}

Object.assign(window, { PRView });
