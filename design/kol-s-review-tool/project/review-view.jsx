// review-view.jsx — PR Review mode: standard diff + Tour (chapters/reading) + Storyboard
function ReviewView({ pr, tweaks, setTweak }) {
  const [mode, setMode] = React.useState('storyboard'); // 'diff' | 'tour' | 'storyboard'
  const [activeFile, setActiveFile] = React.useState(0);
  const [reviewedChapters, setReviewedChapters] = React.useState({});
  const toggleChapterReviewed = (id) => setReviewedChapters(s => ({...s, [id]: !s[id]}));

  return (
    <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0, background:'var(--bg)'}}>
      {/* review toolbar */}
      <div style={{
        height:42, borderBottom:'1px solid var(--line)', display:'flex', alignItems:'center',
        padding:'0 14px', gap:10, background:'var(--bg-elev)', flexShrink:0,
      }}>
        <span className="mono" style={{fontSize:12, color:'var(--ink-3)'}}>{pr.repo} #{pr.id}</span>
        <span style={{fontSize:13, fontWeight:500, color:'var(--ink)'}} className="ellipsis">{pr.title}</span>
        <span style={{flex:1}}/>

        {/* segmented — 3 modes */}
        <div style={{display:'flex', padding:2, background:'var(--bg-soft)', borderRadius:7, border:'1px solid var(--line)'}}>
          <button onClick={()=>setMode('diff')} className={"subtab" + (mode==='diff'?' active':'')} style={{height:24, padding:'0 10px', fontSize:11.5}}>
            <IconSplit/> Diff
          </button>
          <button onClick={()=>setMode('tour')} className={"subtab" + (mode==='tour'?' active':'')} style={{height:24, padding:'0 10px', fontSize:11.5}}>
            <IconSparkle/> Tour
          </button>
          <button onClick={()=>setMode('storyboard')} className={"subtab" + (mode==='storyboard'?' active':'')} style={{height:24, padding:'0 10px', fontSize:11.5}}>
            <IconFlow/> Storyboard
          </button>
        </div>

        <button className="btn" style={{height:26, fontSize:11.5}}><IconComment style={{width:11, height:11}}/> Comment</button>
        <button className="btn primary" style={{height:26, fontSize:11.5}}><IconCheck style={{width:11, height:11}}/> Finish review</button>
      </div>

      {mode === 'diff' && <StandardDiff pr={pr} activeFile={activeFile} setActiveFile={setActiveFile}/>}
      {mode === 'tour' && <AITour pr={pr} variant={tweaks.tourVariant === 'reading' ? 'reading' : 'chapters'} reviewed={reviewedChapters} toggleReviewed={toggleChapterReviewed}/>}
      {mode === 'storyboard' && <TourStoryboard pr={pr} reviewed={reviewedChapters} toggleReviewed={toggleChapterReviewed}/>}
    </div>
  );
}

// ─────────── Standard diff ───────────
// Single scrollable surface — all files stacked vertically. The file tree
// jumps you to the right header via scrollIntoView-equivalent (manual offset)
// and the active item updates as you scroll past file boundaries.
function FileList({files, activeFile, onPick}) {
  // Group files by top-level directory.
  const groups = React.useMemo(() => {
    const m = new Map();
    files.forEach((f, i) => {
      const top = f.path.includes('/') ? f.path.split('/')[0] : '·';
      if (!m.has(top)) m.set(top, []);
      m.get(top).push({ ...f, _idx: i });
    });
    return [...m.entries()];
  }, [files]);

  return (
    <div style={{display:'flex', flexDirection:'column', gap:2}}>
      {groups.map(([dir, items]) => (
        <div key={dir} style={{padding:'2px 0'}}>
          <div style={{padding:'4px 12px', fontSize:10, fontWeight:600, color:'var(--ink-4)', textTransform:'uppercase', letterSpacing:'0.05em', display:'flex', alignItems:'center', gap:6}}>
            <IconFolder style={{width:11, height:11}}/>
            <span className="mono">{dir}</span>
            <span style={{color:'var(--ink-4)', fontWeight:400}}>· {items.length}</span>
          </div>
          {items.map(it => {
            const i = it._idx;
            const isActive = i === activeFile;
            const fname = it.path.split('/').pop();
            const sub = it.path.includes('/') ? it.path.split('/').slice(1, -1).join('/') : '';
            const statusColor = it.status === 'added' ? 'var(--add)'
                              : it.status === 'deleted' ? 'var(--del)'
                              : it.status === 'modified' ? 'oklch(0.65 0.13 75)'
                              : 'var(--ink-4)';
            return (
              <button key={it.path} onClick={()=>onPick(i)} style={{
                width:'100%', textAlign:'left',
                padding:'5px 12px 5px 26px',
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                border:'none', borderLeft: '2px solid ' + (isActive ? 'var(--accent)' : 'transparent'),
                color: isActive ? 'var(--ink)' : 'var(--ink-2)',
                fontSize: 12, fontFamily:'var(--font-ui)',
                cursor:'pointer', display:'flex', alignItems:'center', gap:6,
                minHeight: 26,
              }}
              onMouseEnter={(e)=>{ if (!isActive) e.currentTarget.style.background='var(--bg-hover, oklch(0.96 0.01 250))'; }}
              onMouseLeave={(e)=>{ if (!isActive) e.currentTarget.style.background='transparent'; }}
              >
                <span style={{width:6, height:6, borderRadius:1.5, background: statusColor, flexShrink:0}}/>
                <span className="mono" style={{fontSize:11.5, fontWeight: isActive ? 600 : 400, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                  {sub && <span style={{color:'var(--ink-4)'}}>{sub}/</span>}
                  {fname}
                </span>
                <span style={{flex:1}}/>
                <span className="mono" style={{fontSize:10}}>
                  {it.plus > 0 && <span style={{color:'var(--add)'}}>+{it.plus}</span>}{' '}
                  {it.minus > 0 && <span style={{color:'var(--del)'}}>−{it.minus}</span>}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function StandardDiff({pr, activeFile, setActiveFile}) {
  const scrollRef = React.useRef(null);
  const fileRefs = React.useRef([]);

  // Re-pick active file based on scroll position
  const onScroll = () => {
    const sc = scrollRef.current;
    if (!sc) return;
    const top = sc.scrollTop + 8;
    let idx = 0;
    for (let i = 0; i < fileRefs.current.length; i++) {
      const el = fileRefs.current[i];
      if (el && el.offsetTop <= top) idx = i;
    }
    if (idx !== activeFile) setActiveFile(idx);
  };

  const jumpTo = (i) => {
    setActiveFile(i);
    const el = fileRefs.current[i];
    const sc = scrollRef.current;
    if (el && sc) sc.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
  };

  // For each PR file, pick a diff payload (cycle through DIFF_FILES so every
  // entry shows actual hunks rather than an empty stub).
  const diffFor = (i) => DIFF_FILES[i % DIFF_FILES.length];

  return (
    <div style={{flex:1, display:'flex', minHeight:0}}>
      {/* file tree */}
      <div style={{
        width:280, borderRight:'1px solid var(--line)', display:'flex', flexDirection:'column',
        background:'var(--bg-soft)', flexShrink:0,
      }}>
        <div style={{padding:'10px 12px', borderBottom:'1px solid var(--line-2)', display:'flex', alignItems:'center', gap:8}}>
          <span style={{fontSize:11, fontWeight:600, color:'var(--ink-3)', letterSpacing:'0.04em', textTransform:'uppercase'}}>Files</span>
          <span className="chip" style={{height:18, fontSize:10, padding:'0 6px'}}>{pr.files.length}</span>
          <span style={{flex:1}}/>
          <button className="iconbtn" style={{width:22, height:22}}><IconFilter/></button>
        </div>
        <div className="scroll" style={{flex:1, padding:'6px 0'}}>
          <FileList files={pr.files} activeFile={activeFile} onPick={jumpTo}/>
        </div>
      </div>

      {/* diff body — every file stacked, single scroll */}
      <div ref={scrollRef} onScroll={onScroll} className="scroll" style={{flex:1, minWidth:0}}>
        <div style={{padding:'14px 18px 60px', display:'flex', flexDirection:'column', gap:18}}>
          {pr.files.map((f, i) => (
            <div key={f.path} ref={(el) => fileRefs.current[i] = el}>
              <DiffFile
                file={{ ...diffFor(i), plus: f.plus, minus: f.minus }}
                pathOverride={f.path}
                status={f.status}
                ordinal={i+1}
                total={pr.files.length}
              />
            </div>
          ))}
          <div style={{
            padding:'18px 0', textAlign:'center', fontSize:12, color:'var(--ink-4)',
            borderTop:'1px solid var(--line-2)', marginTop:8,
          }}>
            End of diff · {pr.files.length} files
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────── Diff file (used everywhere) ───────────
function DiffFile({file, pathOverride, compact=false, status, ordinal, total}) {
  const path = pathOverride || file.path;
  const statusChip = status === 'added'   ? <span className="chip add" style={{height:18, fontSize:10, padding:'0 6px'}}>added</span>
                   : status === 'deleted' ? <span className="chip del" style={{height:18, fontSize:10, padding:'0 6px'}}>deleted</span>
                   : status === 'modified' ? <span className="chip warn" style={{height:18, fontSize:10, padding:'0 6px'}}>modified</span>
                   : null;
  return (
    <div style={{padding: compact ? '0' : '0'}}>
      <div style={{
        display:'flex', alignItems:'center', gap:10,
        padding:'10px 14px', background:'var(--bg-elev)',
        border:'1px solid var(--line)', borderRadius:'8px 8px 0 0',
        borderBottom:'1px solid var(--line)',
        position:'sticky', top:0, zIndex:2,
      }}>
        {ordinal != null && (
          <span className="mono" style={{fontSize:10.5, color:'var(--ink-4)', minWidth:32}}>
            {String(ordinal).padStart(2,'0')}/{String(total).padStart(2,'0')}
          </span>
        )}
        <IconFile style={{width:13, height:13, color:'var(--ink-3)'}}/>
        <span className="mono" style={{fontSize:12, color:'var(--ink)', fontWeight:500}}>{path}</span>
        {statusChip}
        <span className="mono" style={{fontSize:11}}>
          {file.plus>0 && <span style={{color:'var(--add)'}}>+{file.plus}</span>}{' '}
          {file.minus>0 && <span style={{color:'var(--del)'}}>−{file.minus}</span>}
        </span>
        <span style={{flex:1}}/>
        <button className="iconbtn" style={{width:24, height:24}}><IconComment/></button>
        <button className="iconbtn" style={{width:24, height:24}}><IconMore/></button>
      </div>

      {file.hunks.map((h, hi) => (
        <div key={hi} style={{border:'1px solid var(--line)', borderTop:'none', background:'var(--bg-elev)', borderRadius: hi===file.hunks.length-1 ? '0 0 8px 8px' : 0}}>
          <div className="mono" style={{
            padding:'4px 14px', fontSize:11, color:'var(--ink-3)',
            background:'var(--accent-soft)',
            borderTop:'1px solid var(--accent-line)',
            borderBottom:'1px solid var(--accent-line)',
          }}>{h.header}</div>
          <div className="mono" style={{fontSize:12, lineHeight:1.6}}>
            {h.lines.map((ln, li) => <DiffLine key={li} ln={ln}/>)}
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffLine({ln}) {
  const bg = ln.t==='+' ? 'var(--add-bg)' : ln.t==='-' ? 'var(--del-bg)' : 'transparent';
  const sign = ln.t==='+' ? <span style={{color:'var(--add)'}}>+</span>
             : ln.t==='-' ? <span style={{color:'var(--del)'}}>−</span>
             : <span style={{color:'var(--ink-4)'}}> </span>;
  return (
    <div style={{display:'grid', gridTemplateColumns:'42px 14px 1fr', background: bg, position:'relative'}}>
      <div style={{textAlign:'right', padding:'0 8px 0 0', color:'var(--ink-4)', fontSize:11, userSelect:'none', borderRight:'1px solid var(--line-2)'}}>{ln.n}</div>
      <div style={{textAlign:'center', userSelect:'none'}}>{sign}</div>
      <div style={{padding:'0 12px', whiteSpace:'pre-wrap', wordBreak:'break-word', color:'var(--ink)'}}>
        <SyntaxLine c={ln.c}/>
        {ln.note && <span style={{
          marginLeft:14, padding:'0 8px', fontSize:11,
          background:'var(--accent-soft)', color:'var(--accent)',
          border:'1px solid var(--accent-line)', borderRadius:999,
          fontFamily:'var(--font-ui)',
          display:'inline-flex', alignItems:'center', gap:5, verticalAlign:'middle',
        }}><IconSparkle style={{width:10, height:10}}/>{ln.note}</span>}
      </div>
    </div>
  );
}

// extremely simple Rust-ish syntax pass — keywords + strings + comments
function SyntaxLine({c}) {
  if (!c) return <span>&nbsp;</span>;
  // comment
  const ci = c.indexOf('//');
  if (ci >= 0) {
    return (<>
      <SyntaxLine c={c.slice(0, ci)}/>
      <span style={{color:'oklch(0.6 0.04 145)', fontStyle:'italic'}}>{c.slice(ci)}</span>
    </>);
  }
  const KW = /\b(pub|fn|let|mut|use|struct|enum|impl|self|Self|return|if|else|loop|while|for|in|match|async|await|move|as|where|const|static|crate|mod|trait|type|true|false|None|Some|Ok|Err)\b/g;
  const TY = /\b(usize|isize|u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|bool|str|String|Vec|Option|Result|Arc|Mutex|VecDeque|Box|HashMap|Notify|StreamPermit|RingCache|RingInner|StreamTier|CacheConfig|BlobHash|Slot|PerRequestBuffer)\b/g;
  // strings
  const parts = [];
  let rest = c;
  let m;
  // tokenize: very rough, sufficient for showcase
  const tokens = [];
  let cursor = 0;
  const matches = [];
  const all = [];
  let r;
  while ((r = KW.exec(c))) all.push({i:r.index, l:r[0].length, k:'kw'});
  while ((r = TY.exec(c))) all.push({i:r.index, l:r[0].length, k:'ty'});
  all.sort((a,b)=>a.i-b.i);
  // dedupe overlaps
  const filtered = [];
  let lastEnd = -1;
  for (const a of all) { if (a.i >= lastEnd) { filtered.push(a); lastEnd = a.i + a.l; } }
  const out = [];
  let p = 0;
  filtered.forEach((a, k) => {
    if (a.i > p) out.push(<span key={'t'+k}>{c.slice(p, a.i)}</span>);
    const text = c.slice(a.i, a.i+a.l);
    const color = a.k==='kw' ? 'oklch(0.5 0.18 280)' : 'oklch(0.45 0.12 220)';
    out.push(<span key={'k'+k} style={{color, fontWeight: a.k==='kw' ? 500 : 400}}>{text}</span>);
    p = a.i + a.l;
  });
  if (p < c.length) out.push(<span key="tail">{c.slice(p)}</span>);
  return <>{out}</>;
}

// ─────────── AI Tour (3 variants) ───────────
function AITour({pr, variant, reviewed, toggleReviewed}) {
  if (variant === 'reading') return <TourReading pr={pr} reviewed={reviewed} toggleReviewed={toggleReviewed}/>;
  if (variant === 'storyboard') return <TourStoryboard pr={pr} reviewed={reviewed} toggleReviewed={toggleReviewed}/>;
  return <TourChapters pr={pr} reviewed={reviewed} toggleReviewed={toggleReviewed}/>;
}

// Variant A: chapter rail + diff (default)
function TourChapters({pr, reviewed, toggleReviewed}) {
  const [active, setActive] = React.useState(0);
  const chapter = TOUR_CHAPTERS[active];
  const file = DIFF_FILES[chapter.diffFile] || DIFF_FILES[0];
  const reviewedCount = TOUR_CHAPTERS.filter(c => reviewed[c.id]).length;
  return (
    <div style={{flex:1, display:'flex', minHeight:0}}>
      {/* chapter rail */}
      <div style={{width:300, borderRight:'1px solid var(--line)', background:'var(--bg-soft)', display:'flex', flexDirection:'column', flexShrink:0}}>
        <div style={{padding:'12px 14px', borderBottom:'1px solid var(--line-2)', display:'flex', alignItems:'center', gap:8}}>
          <IconSparkle style={{width:13, height:13, color:'var(--accent)'}}/>
          <span style={{fontSize:12.5, fontWeight:600}}>Tour</span>
          <span className="chip" style={{height:18, fontSize:10, padding:'0 6px'}}>{reviewedCount}/{TOUR_CHAPTERS.length} reviewed</span>
        </div>
        <div className="scroll" style={{flex:1}}>
          {TOUR_CHAPTERS.map((c, i) => {
            const isReviewed = !!reviewed[c.id];
            return (
              <div key={c.id} onClick={()=>setActive(i)} style={{
                padding:'12px 14px', borderBottom:'1px solid var(--line-2)',
                background: i===active ? 'var(--bg-elev)' : 'transparent',
                borderLeft: i===active ? '2px solid var(--accent)' : '2px solid transparent',
                cursor:'default', opacity: isReviewed ? 0.65 : 1,
              }}>
                <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:4}}>
                  <ChapterCheck reviewed={isReviewed} onToggle={(e)=>{ e.stopPropagation(); toggleReviewed(c.id); }}/>
                  {c.sensitive && <CautionIcon title={c.sensitiveReason || 'Needs rigorous review'}/>}
                  <span style={{fontSize:12.5, color: i===active ? 'var(--ink)' : 'var(--ink-2)', fontWeight: i===active ? 600 : 500, lineHeight:1.3, textDecoration: isReviewed ? 'line-through' : 'none', textDecorationColor: 'var(--ink-4)'}}>{c.title}</span>
                </div>
                <div style={{paddingLeft:24, display:'flex', alignItems:'center', gap:8, fontSize:10.5, color:'var(--ink-3)'}}>
                  <span className="mono" style={{color:'var(--ink-4)', fontWeight:500, width:18}}>{String(i+1).padStart(2,'0')}</span>
                  <span className="mono">{c.files.length} {c.files.length===1?'file':'files'}</span>
                  <span className="mono" style={{color:'var(--add)'}}>+{c.plus}</span>
                  <span className="mono" style={{color:'var(--del)'}}>−{c.minus}</span>
                  {c.flagged && <span className="chip warn" style={{height:16, fontSize:9.5, padding:'0 5px', marginLeft:'auto'}}>flagged</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{padding:10, borderTop:'1px solid var(--line)', display:'flex', gap:6}}>
          <button className="btn" style={{flex:1, height:26, fontSize:11.5, justifyContent:'center'}} onClick={()=>setActive(Math.max(0, active-1))} disabled={active===0}>
            <IconChevR style={{transform:'rotate(180deg)', width:11, height:11}}/> Prev
          </button>
          <button className="btn primary" style={{flex:1, height:26, fontSize:11.5, justifyContent:'center'}} onClick={()=>{
            toggleReviewed(chapter.id);
            if (active < TOUR_CHAPTERS.length-1) setActive(active+1);
          }}>
            <IconCheck style={{width:11, height:11}}/> {reviewed[chapter.id] ? 'Unmark' : 'Mark reviewed'}
          </button>
        </div>
      </div>

      {/* chapter body */}
      <div className="scroll" style={{flex:1, minWidth:0}}>
        <div style={{padding:'24px 28px', maxWidth:920}}>
          <div style={{display:'flex', alignItems:'center', gap:8, fontSize:11, color:'var(--ink-3)', letterSpacing:'0.05em', textTransform:'uppercase', fontWeight:600, marginBottom:8}}>
            <span>Chapter {active+1} of {TOUR_CHAPTERS.length}</span>
            {reviewed[chapter.id] && <span className="chip add" style={{height:18, fontSize:10, padding:'0 6px', textTransform:'none', letterSpacing:0}}><IconCheck style={{width:9, height:9}}/>Reviewed</span>}
            <span style={{flex:1, height:1, background:'var(--line)'}}/>
            <span style={{textTransform:'none', letterSpacing:0, fontWeight:400, color:'var(--ink-4)', display:'inline-flex', alignItems:'center', gap:4}}>
              <IconSparkle style={{width:11, height:11}}/>AI generated · explained from {pr.author.handle}'s description
            </span>
          </div>
          <h2 style={{fontFamily:'var(--font-display)', fontSize:24, fontWeight:600, letterSpacing:'-0.02em', margin:'0 0 12px', textWrap:'pretty', display:'flex', alignItems:'center', gap:10}}>
            {chapter.sensitive && <CautionIcon title={chapter.sensitiveReason}/>}
            {chapter.title}
          </h2>

          {chapter.sensitive && (
            <div style={{
              padding:'10px 12px', borderRadius:8, background:'oklch(0.97 0.05 35)',
              border:'1px solid oklch(0.86 0.1 35)', fontSize:12, color:'oklch(0.4 0.12 35)',
              display:'flex', gap:8, alignItems:'flex-start', marginBottom:14,
            }}>
              <CautionIcon/>
              <div>
                <strong style={{fontWeight:600}}>Sensitive change · rigorous review needed.</strong> {chapter.sensitiveReason}
              </div>
            </div>
          )}

          <div style={{display:'flex', flexWrap:'wrap', gap:6, marginBottom:16}}>
            {chapter.files.map(f => <span key={f} className="chip" style={{height:22, fontSize:11}}><IconFile style={{width:10, height:10}}/>{f}</span>)}
            <span className="chip add" style={{height:22, fontSize:11}}>+{chapter.plus}</span>
            <span className="chip del" style={{height:22, fontSize:11}}>−{chapter.minus}</span>
          </div>

          <p style={{fontSize:14, color:'var(--ink-2)', lineHeight:1.65, margin:'0 0 14px', textWrap:'pretty'}}>{chapter.summary}</p>

          <ul style={{margin:'0 0 22px', paddingLeft:18, fontSize:13, color:'var(--ink-2)', lineHeight:1.65}}>
            {chapter.bullets.map((b,k) => <li key={k} style={{margin:'4px 0'}}>{b}</li>)}
          </ul>

          {chapter.flagged && (
            <div style={{
              padding:'10px 12px', borderRadius:8, background:'oklch(0.97 0.05 75)',
              border:'1px solid oklch(0.86 0.1 75)', fontSize:12, color:'oklch(0.4 0.1 75)',
              display:'flex', gap:8, alignItems:'flex-start', marginBottom:18,
            }}>
              <IconLightbulb style={{width:14, height:14, flexShrink:0, marginTop:1}}/>
              <div>
                <strong style={{fontWeight:600}}>Reviewer flagged:</strong> Renata noted this chapter does two things — protection flag + per-tier counter. Consider splitting into two follow-up commits.
              </div>
            </div>
          )}

          <DiffFile file={file}/>
        </div>
      </div>
    </div>
  );
}

function ChapterCheck({reviewed, onToggle}) {
  return (
    <button onClick={onToggle} title={reviewed ? 'Mark unreviewed' : 'Mark reviewed'} style={{
      width:16, height:16, borderRadius:4,
      border:'1.5px solid ' + (reviewed ? 'var(--add)' : 'var(--ink-4)'),
      background: reviewed ? 'var(--add)' : 'transparent',
      display:'grid', placeItems:'center',
      flexShrink:0, padding:0, color:'white',
    }}>
      {reviewed && <IconCheck style={{width:10, height:10}}/>}
    </button>
  );
}

function CautionIcon({title}) {
  return (
    <span title={title} style={{
      width:16, height:16, flexShrink:0,
      display:'grid', placeItems:'center',
      color:'oklch(0.55 0.18 35)',
    }}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
        <path d="M8 1.5 L14.5 13 H1.5 Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="oklch(0.97 0.05 35)"/>
        <path d="M8 6 V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="8" cy="11" r="0.75" fill="currentColor"/>
      </svg>
    </span>
  );
}

// Variant B: reading mode — prose + inline mini diffs
function TourReading({pr}) {
  return (
    <div className="scroll" style={{flex:1}}>
      <div style={{maxWidth:760, margin:'0 auto', padding:'40px 32px 80px'}}>
        <div style={{fontSize:11, color:'var(--ink-3)', letterSpacing:'0.06em', textTransform:'uppercase', fontWeight:600, marginBottom:8, display:'flex', alignItems:'center', gap:6}}>
          <IconSparkle style={{width:11, height:11}}/> AI Tour · reading mode
        </div>
        <h1 style={{fontFamily:'var(--font-display)', fontSize:30, fontWeight:600, letterSpacing:'-0.025em', margin:'0 0 8px', lineHeight:1.15}}>How this PR fits together</h1>
        <p style={{fontSize:14.5, color:'var(--ink-3)', lineHeight:1.6, margin:'0 0 28px'}}>
          A continuous walkthrough of the change. Skim the prose, click any code block to jump into the standard diff at that line.
        </p>

        {TOUR_CHAPTERS.map((c, i) => (
          <section key={c.id} style={{margin:'34px 0'}}>
            <div style={{display:'flex', alignItems:'baseline', gap:10, marginBottom:8}}>
              <span className="mono" style={{fontSize:11, color:'var(--ink-4)', fontWeight:500}}>{String(i+1).padStart(2,'0')}</span>
              <h2 style={{fontFamily:'var(--font-display)', fontSize:20, fontWeight:600, letterSpacing:'-0.015em', margin:0, lineHeight:1.25}}>{c.title}</h2>
            </div>
            <p style={{fontSize:14, color:'var(--ink-2)', lineHeight:1.7, margin:'0 0 12px', textWrap:'pretty'}}>{c.summary}</p>
            <ul style={{margin:'0 0 14px', paddingLeft:18, fontSize:13, color:'var(--ink-2)', lineHeight:1.65}}>
              {c.bullets.map((b,k) => <li key={k} style={{margin:'4px 0'}}>{b}</li>)}
            </ul>
            <MiniDiff file={DIFF_FILES[c.diffFile] || DIFF_FILES[0]} maxLines={8}/>
          </section>
        ))}
      </div>
    </div>
  );
}

function MiniDiff({file, maxLines = 6}) {
  const lines = file.hunks[0].lines.slice(0, maxLines);
  return (
    <div style={{border:'1px solid var(--line)', borderRadius:8, background:'var(--bg-elev)', overflow:'hidden'}}>
      <div style={{padding:'6px 12px', fontSize:11, color:'var(--ink-3)', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid var(--line-2)', background:'var(--bg-soft)'}}>
        <IconFile style={{width:11, height:11}}/>
        <span className="mono">{file.path}</span>
        <span style={{flex:1}}/>
        <span style={{fontSize:11, color:'var(--ink-4)'}}>show in diff →</span>
      </div>
      <div className="mono" style={{fontSize:11.5, lineHeight:1.6}}>
        {lines.map((ln, li) => <DiffLine key={li} ln={ln}/>)}
      </div>
      {file.hunks[0].lines.length > maxLines && (
        <div style={{padding:'6px 12px', fontSize:11, color:'var(--ink-4)', borderTop:'1px solid var(--line-2)', background:'var(--bg-soft)'}}>
          + {file.hunks[0].lines.length - maxLines} more lines
        </div>
      )}
    </div>
  );
}

// Variant C: storyboard — chapters laid out as a flow chart with edges
// 4-tier left→right layout with orthogonal routing for clarity.
const FLOW_LAYOUT = {
  ch1: { col: 0, row: 1, kind: 'foundation' },  // StreamPermit (primitive)
  ch2: { col: 1, row: 1, kind: 'replace' },     // RingCache replaces buffer
  ch4: { col: 2, row: 0, kind: 'extend' },      // Tiered eviction (extends ring)
  ch3: { col: 2, row: 2, kind: 'glue' },        // Producer plumbing
  ch5: { col: 3, row: 0, kind: 'gate' },        // Config + flag
  ch6: { col: 3, row: 2, kind: 'verify' },      // Tests + observability
};

// Pruned to direct, non-transitive deps. Categorized for color coding.
const FLOW_EDGES = [
  { from: 'ch1', to: 'ch2', rel: 'depends' },
  { from: 'ch2', to: 'ch4', rel: 'extends' },
  { from: 'ch1', to: 'ch3', rel: 'depends' },
  { from: 'ch2', to: 'ch3', rel: 'depends' },
  { from: 'ch4', to: 'ch5', rel: 'gates'   },
  { from: 'ch3', to: 'ch6', rel: 'verifies'},
  { from: 'ch4', to: 'ch6', rel: 'verifies'},
];

const REL_META = {
  depends:  { label: 'depends on',   color: 'oklch(0.5 0.02 270)',  dash: '0' },
  extends:  { label: 'extends',      color: 'oklch(0.55 0.13 145)', dash: '0' },
  gates:    { label: 'gated by',     color: 'oklch(0.55 0.15 75)',  dash: '5 4' },
  verifies: { label: 'verified by',  color: 'oklch(0.5 0.12 290)',  dash: '2 3' },
};

const KIND_META = {
  foundation: { label: 'Foundation', color: 'oklch(0.55 0.15 250)', bg: 'oklch(0.97 0.03 250)' },
  replace:    { label: 'Replace',    color: 'oklch(0.55 0.15 25)',  bg: 'oklch(0.97 0.03 25)' },
  glue:       { label: 'Glue',       color: 'oklch(0.5 0.05 250)',  bg: 'oklch(0.97 0.01 250)' },
  extend:     { label: 'Extend',     color: 'oklch(0.55 0.13 145)', bg: 'oklch(0.97 0.04 145)' },
  gate:       { label: 'Gate',       color: 'oklch(0.55 0.15 75)',  bg: 'oklch(0.97 0.05 75)' },
  verify:     { label: 'Verify',     color: 'oklch(0.5 0.1 290)',   bg: 'oklch(0.97 0.04 290)' },
};

function TourStoryboard({pr, reviewed, toggleReviewed}) {
  const [active, setActive] = React.useState('ch1');
  const [hoveredEdge, setHoveredEdge] = React.useState(null); // 'from|to' key
  const reviewedCount = TOUR_CHAPTERS.filter(c => reviewed[c.id]).length;
  const edgeKey = (e) => `${e.from}|${e.to}`;

  // Grid metrics
  const COL_W = 268, COL_GAP = 90;
  const ROW_H = 168, ROW_GAP = 32;
  const PAD_X = 40, PAD_Y = 32;
  const CARD_W = 248, CARD_H = 156;

  const pos = (id) => {
    const l = FLOW_LAYOUT[id];
    return { x: PAD_X + l.col * (COL_W + COL_GAP), y: PAD_Y + l.row * (ROW_H + ROW_GAP) };
  };

  const totalW = PAD_X*2 + 4 * COL_W + 3 * COL_GAP - (COL_W - CARD_W);
  const totalH = PAD_Y*2 + 3 * ROW_H + 2 * ROW_GAP - (ROW_H - CARD_H);

  // Stagger ports per card so multiple edges entering/leaving don't overlap.
  const outgoing = {}, incoming = {};
  FLOW_EDGES.forEach(e => {
    outgoing[e.from] = (outgoing[e.from] || []).concat(e);
    incoming[e.to]   = (incoming[e.to]   || []).concat(e);
  });
  const portY = (cardId, edges, edge, edgeKind) => {
    const list = edges[cardId] || [];
    const idx = list.indexOf(edge);
    const n = list.length;
    if (n <= 1) return CARD_H/2;
    // Spread ports across vertical span [25%, 75%] of card height
    return CARD_H * (0.3 + (idx / Math.max(1, n-1)) * 0.4);
  };

  const activeChapter = TOUR_CHAPTERS.find(c => c.id === active);

  // Compute orthogonal Manhattan paths.
  const edgePaths = FLOW_EDGES.map((e) => {
    const a = pos(e.from), b = pos(e.to);
    const x1 = a.x + CARD_W;
    const y1 = a.y + portY(e.from, outgoing, e, 'out');
    const x2 = b.x;
    const y2 = b.y + portY(e.to,   incoming, e, 'in');
    // Route: short stub right, then vertical to target row, then short stub left.
    const midX = x1 + Math.max(28, (x2 - x1) / 2);
    const r = 8; // corner radius
    let d;
    if (Math.abs(y1 - y2) < 1) {
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else if (y2 > y1) {
      d = `M ${x1} ${y1} L ${midX-r} ${y1} Q ${midX} ${y1} ${midX} ${y1+r} L ${midX} ${y2-r} Q ${midX} ${y2} ${midX+r} ${y2} L ${x2} ${y2}`;
    } else {
      d = `M ${x1} ${y1} L ${midX-r} ${y1} Q ${midX} ${y1} ${midX} ${y1-r} L ${midX} ${y2+r} Q ${midX} ${y2} ${midX+r} ${y2} L ${x2} ${y2}`;
    }
    const key = `${e.from}|${e.to}`;
    const isHovered = hoveredEdge === key;
    // When a specific connection is hovered, ONLY that edge highlights.
    // Otherwise, the active node's edges all highlight.
    const isHot = hoveredEdge
      ? isHovered
      : (active === e.from || active === e.to);
    const meta = REL_META[e.rel];
    // Label sits on the vertical segment (or on the horizontal for same-row edges).
    const labelX = midX;
    const labelY = Math.abs(y1 - y2) < 1 ? y1 - 8 : (y1 + y2) / 2;
    return { ...e, d, x1, y1, x2, y2, isHot, isHovered, meta, labelX, labelY, key };
  });

  return (
    <div style={{flex:1, display:'flex', flexDirection:'column', minHeight:0, background:'var(--bg-soft)'}}>
      {/* header */}
      <div style={{padding:'12px 18px', display:'flex', alignItems:'center', gap:10, borderBottom:'1px solid var(--line)', background:'var(--bg)', flexShrink:0, flexWrap:'wrap'}}>
        <IconSparkle style={{width:13, height:13, color:'var(--accent)'}}/>
        <span style={{fontSize:12.5, fontWeight:600}}>Storyboard</span>
        <span style={{fontSize:11.5, color:'var(--ink-3)'}}>· dependency flow</span>
        <span className="chip" style={{height:18, fontSize:10, padding:'0 6px', marginLeft:6}}>{reviewedCount}/{TOUR_CHAPTERS.length} reviewed</span>
        <span style={{flex:1}}/>
        {/* edge legend */}
        <div style={{display:'flex', gap:14, alignItems:'center'}}>
          {Object.entries(REL_META).map(([k, m]) => (
            <span key={k} style={{display:'inline-flex', alignItems:'center', gap:6, fontSize:11, color:'var(--ink-3)'}}>
              <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke={m.color} strokeWidth="1.6" strokeDasharray={m.dash}/></svg>
              {m.label}
            </span>
          ))}
        </div>
      </div>

      {/* split: flow + detail */}
      <div style={{flex:1, display:'flex', minHeight:0}}>
        <div className="scroll" style={{flex:1, minWidth:0, overflow:'auto', background:'var(--bg-soft)', backgroundImage:'radial-gradient(circle, var(--line-2) 1px, transparent 1px)', backgroundSize:'18px 18px', backgroundPosition:'-1px -1px'}}>
          <div style={{position:'relative', width: totalW, height: totalH}}>
            {/* edges */}
            <svg width={totalW} height={totalH} style={{position:'absolute', inset:0, pointerEvents:'none'}}>
              <defs>
                {Object.entries(REL_META).map(([k, m]) => (
                  <marker key={k} id={`ah-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto">
                    <path d="M0,0 L10,5 L0,10 z" fill={m.color}/>
                  </marker>
                ))}
                <marker id="ah-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/>
                </marker>
              </defs>
              {/* dimmed edges */}
              {edgePaths.filter(e => !e.isHot).map((e, i) => (
                <path key={'e'+i} d={e.d} stroke={e.meta.color} strokeWidth="1.5" fill="none"
                  strokeDasharray={e.meta.dash} strokeLinecap="round" strokeLinejoin="round"
                  markerEnd={`url(#ah-${e.rel})`} opacity="0.5"/>
              ))}
              {/* highlighted edges last */}
              {edgePaths.filter(e => e.isHot).map((e, i) => (
                <g key={'eh'+i}>
                  <path d={e.d} stroke="var(--accent)" strokeWidth="6" fill="none" opacity="0.12"
                    strokeLinecap="round" strokeLinejoin="round"/>
                  <path d={e.d} stroke="var(--accent)" strokeWidth="2" fill="none"
                    strokeDasharray={e.meta.dash} strokeLinecap="round" strokeLinejoin="round"
                    markerEnd="url(#ah-hot)"/>
                </g>
              ))}
              {/* edge labels — small pill at midpoint of vertical segment */}
              {edgePaths.map((e, i) => {
                const text = e.meta.label;
                const w = text.length * 5.6 + 12;
                const h = 14;
                const fill = e.isHot ? 'var(--accent-soft)' : 'var(--bg)';
                const stroke = e.isHot ? 'var(--accent-line)' : e.meta.color;
                const textColor = e.isHot ? 'var(--accent)' : e.meta.color;
                return (
                  <g key={'el'+i} style={{pointerEvents:'none'}} opacity={e.isHot ? 1 : 0.9}>
                    <rect x={e.labelX - w/2} y={e.labelY - h/2} width={w} height={h} rx="3"
                      fill={fill} stroke={stroke} strokeWidth="1" strokeOpacity={e.isHot ? 1 : 0.55}/>
                    <text x={e.labelX} y={e.labelY + 3} textAnchor="middle"
                      style={{fontSize:9.5, fontFamily:'var(--font-mono)', fill: textColor, fontWeight: e.isHot ? 600 : 500, letterSpacing:'0.01em'}}>
                      {text}
                    </text>
                  </g>
                );
              })}
            </svg>

            {/* nodes */}
            {TOUR_CHAPTERS.map((c, i) => {
              const p = pos(c.id);
              const meta = KIND_META[FLOW_LAYOUT[c.id].kind];
              const isActive = active === c.id;
              const isReviewed = !!reviewed[c.id];
              return (
                <div key={c.id} onMouseEnter={()=>setActive(c.id)} style={{
                  position:'absolute',
                  left: p.x, top: p.y, width: CARD_W, height: CARD_H,
                  background:'var(--bg-elev)',
                  border: '1.5px solid ' + (isActive ? 'var(--accent)' : c.sensitive ? 'oklch(0.7 0.15 35)' : 'var(--line)'),
                  borderRadius:10,
                  boxShadow: isActive ? '0 0 0 3px var(--accent-soft), 0 4px 16px rgba(0,0,0,0.06)' : '0 1px 3px rgba(0,0,0,0.04)',
                  cursor:'pointer',
                  display:'flex', flexDirection:'column',
                  overflow:'hidden',
                  opacity: isReviewed ? 0.78 : 1,
                  transition: 'box-shadow 120ms, border-color 120ms',
                }}>
                  <div style={{height:4, background: meta.color}}/>
                  <div style={{padding:'10px 12px 8px', display:'flex', alignItems:'center', gap:6}}>
                    <span style={{
                      fontSize:9.5, fontFamily:'var(--font-mono)', fontWeight:600,
                      color: meta.color, background: meta.bg,
                      padding:'1px 6px', borderRadius:3,
                      letterSpacing:'0.04em', textTransform:'uppercase',
                    }}>{meta.label}</span>
                    <span className="mono" style={{fontSize:9.5, color:'var(--ink-4)'}}>ch {String(i+1).padStart(2,'0')}</span>
                    <span style={{flex:1}}/>
                    {c.sensitive && <CautionIcon title={c.sensitiveReason}/>}
                    <ChapterCheck reviewed={isReviewed} onToggle={(e)=>{e.stopPropagation(); toggleReviewed(c.id);}}/>
                  </div>
                  <div style={{padding:'0 12px 8px'}}>
                    <div style={{fontFamily:'var(--font-display)', fontSize:13.5, fontWeight:600, letterSpacing:'-0.01em', lineHeight:1.25, textWrap:'balance', textDecoration: isReviewed ? 'line-through' : 'none', textDecorationColor:'var(--ink-4)'}}>{c.title}</div>
                  </div>
                  <div style={{padding:'0 12px', flex:1, minHeight:0, overflow:'hidden'}}>
                    <p style={{fontSize:11, color:'var(--ink-3)', lineHeight:1.45, margin:0, display:'-webkit-box', WebkitLineClamp:3, WebkitBoxOrient:'vertical', overflow:'hidden'}}>{c.summary}</p>
                  </div>
                  <div style={{padding:'8px 12px', borderTop:'1px solid var(--line-2)', background:'var(--bg-soft)', display:'flex', alignItems:'center', gap:6, fontSize:10}}>
                    <span className="mono" style={{color:'var(--ink-4)'}}>{c.files.length}f</span>
                    <span className="mono" style={{color:'var(--add)'}}>+{c.plus}</span>
                    <span className="mono" style={{color:'var(--del)'}}>−{c.minus}</span>
                    {c.flagged && <span className="chip warn" style={{height:14, fontSize:9, padding:'0 4px', marginLeft:'auto'}}>flagged</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* detail rail */}
        <div style={{width:340, borderLeft:'1px solid var(--line)', background:'var(--bg)', display:'flex', flexDirection:'column', flexShrink:0}}>
          {activeChapter && (() => {
            const meta = KIND_META[FLOW_LAYOUT[activeChapter.id].kind];
            const idx = TOUR_CHAPTERS.findIndex(c => c.id === activeChapter.id);
            const incoming = FLOW_EDGES.filter(e => e.to === activeChapter.id);
            const outgoing = FLOW_EDGES.filter(e => e.from === activeChapter.id);
            const isReviewed = !!reviewed[activeChapter.id];
            return (
              <>
                <div style={{padding:'14px 16px', borderBottom:'1px solid var(--line-2)'}}>
                  <div style={{display:'flex', alignItems:'center', gap:6, marginBottom:6}}>
                    <span style={{
                      fontSize:9.5, fontFamily:'var(--font-mono)', fontWeight:600,
                      color: meta.color, background: meta.bg,
                      padding:'2px 7px', borderRadius:3,
                      letterSpacing:'0.04em', textTransform:'uppercase',
                    }}>{meta.label}</span>
                    <span className="mono" style={{fontSize:10, color:'var(--ink-4)'}}>chapter {String(idx+1).padStart(2,'0')}</span>
                    {activeChapter.sensitive && <CautionIcon title={activeChapter.sensitiveReason}/>}
                  </div>
                  <h3 style={{fontFamily:'var(--font-display)', fontSize:16, fontWeight:600, letterSpacing:'-0.01em', margin:'0 0 8px', textWrap:'pretty'}}>{activeChapter.title}</h3>
                  <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
                    {activeChapter.files.map(f => <span key={f} className="chip" style={{height:20, fontSize:10.5}}><IconFile style={{width:9, height:9}}/>{f.split('/').pop()}</span>)}
                  </div>
                </div>
                <div className="scroll" style={{flex:1, padding:'12px 16px'}}>
                  <p style={{fontSize:12, color:'var(--ink-2)', lineHeight:1.6, margin:'0 0 14px', textWrap:'pretty'}}>{activeChapter.summary}</p>

                  {(incoming.length > 0 || outgoing.length > 0) && (
                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:10, fontWeight:600, color:'var(--ink-3)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:6}}>Connections</div>
                      {incoming.map((e, i) => {
                        const src = TOUR_CHAPTERS.find(c => c.id === e.from);
                        const k = `${e.from}|${e.to}`;
                        const isHov = hoveredEdge === k;
                        return (
                          <div key={'in'+i} onClick={()=>setActive(e.from)}
                            onMouseEnter={()=>setHoveredEdge(k)}
                            onMouseLeave={()=>setHoveredEdge(null)}
                            style={{display:'flex', alignItems:'center', gap:6, padding:'4px 6px', borderRadius:4, fontSize:11, cursor:'pointer', background: isHov ? 'var(--accent-soft)' : '', boxShadow: isHov ? 'inset 0 0 0 1px var(--accent-line)' : ''}}>
                            <span className="mono" style={{color: isHov ? 'var(--accent)' : 'var(--ink-4)', fontSize:10, fontWeight: isHov ? 600 : 400}}>← {e.label}</span>
                            <span style={{color:'var(--ink-2)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{src.title}</span>
                          </div>
                        );
                      })}
                      {outgoing.map((e, i) => {
                        const dst = TOUR_CHAPTERS.find(c => c.id === e.to);
                        const k = `${e.from}|${e.to}`;
                        const isHov = hoveredEdge === k;
                        return (
                          <div key={'out'+i} onClick={()=>setActive(e.to)}
                            onMouseEnter={()=>setHoveredEdge(k)}
                            onMouseLeave={()=>setHoveredEdge(null)}
                            style={{display:'flex', alignItems:'center', gap:6, padding:'4px 6px', borderRadius:4, fontSize:11, cursor:'pointer', background: isHov ? 'var(--accent-soft)' : '', boxShadow: isHov ? 'inset 0 0 0 1px var(--accent-line)' : ''}}>
                            <span className="mono" style={{color: isHov ? 'var(--accent)' : 'var(--ink-4)', fontSize:10, fontWeight: isHov ? 600 : 400}}>→ {e.label}</span>
                            <span style={{color:'var(--ink-2)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{dst.title}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div style={{fontSize:10, fontWeight:600, color:'var(--ink-3)', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:6}}>Key points</div>
                  <ul style={{margin:'0 0 14px', paddingLeft:16, fontSize:12, color:'var(--ink-2)', lineHeight:1.55}}>
                    {activeChapter.bullets.map((b, k) => <li key={k} style={{margin:'3px 0'}}>{b}</li>)}
                  </ul>

                  {activeChapter.sensitive && (
                    <div style={{
                      padding:'8px 10px', borderRadius:6, background:'oklch(0.97 0.05 35)',
                      border:'1px solid oklch(0.86 0.1 35)', fontSize:11, color:'oklch(0.4 0.12 35)',
                      display:'flex', gap:6, alignItems:'flex-start', marginBottom:10, lineHeight:1.45,
                    }}>
                      <CautionIcon/>
                      <div><strong style={{fontWeight:600}}>Rigorous review needed.</strong> {activeChapter.sensitiveReason}</div>
                    </div>
                  )}
                </div>
                <div style={{padding:10, borderTop:'1px solid var(--line)', display:'flex', gap:6}}>
                  <button className="btn primary" style={{flex:1, height:26, fontSize:11.5, justifyContent:'center'}} onClick={()=>toggleReviewed(activeChapter.id)}>
                    <IconCheck style={{width:11, height:11}}/> {isReviewed ? 'Unmark' : 'Mark reviewed'}
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ReviewView });
