// app.jsx — top-level shell: title bar + left rail + tab strip + view router
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "tourVariant": "chapters",
  "density": "compact",
  "accent": "indigo",
  "windowed": true
}/*EDITMODE-END*/;

const ACCENTS = {
  indigo: { accent:'oklch(0.5 0.18 280)', accent2:'oklch(0.62 0.16 280)', soft:'oklch(0.96 0.03 280)', line:'oklch(0.85 0.07 280)'},
  ember:  { accent:'oklch(0.58 0.16 30)',  accent2:'oklch(0.68 0.14 30)',  soft:'oklch(0.97 0.03 30)',  line:'oklch(0.86 0.07 30)' },
  pine:   { accent:'oklch(0.5 0.13 160)',  accent2:'oklch(0.62 0.12 160)', soft:'oklch(0.96 0.03 160)', line:'oklch(0.85 0.06 160)'},
  graphite:{accent:'oklch(0.32 0.01 270)', accent2:'oklch(0.42 0.01 270)', soft:'oklch(0.95 0.005 270)',line:'oklch(0.85 0.005 270)'},
};

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // tabs (open PRs); each has a viewMode (view / review / editor / search)
  const [tabs, setTabs] = React.useState([
    { id:'pr-4128', kind:'pr', pr: PR_DETAIL, viewMode:'review', dirty:false },
    { id:'pr-4124', kind:'pr', pr: SAMPLE_PRS[2], viewMode:'view' },
  ]);
  const [activeTab, setActiveTab] = React.useState('pr-4128');
  const [searchOpen, setSearchOpen] = React.useState(false);

  // apply accent CSS vars
  React.useEffect(() => {
    const a = ACCENTS[tweaks.accent] || ACCENTS.indigo;
    document.documentElement.style.setProperty('--accent', a.accent);
    document.documentElement.style.setProperty('--accent-2', a.accent2);
    document.documentElement.style.setProperty('--accent-soft', a.soft);
    document.documentElement.style.setProperty('--accent-line', a.line);
  }, [tweaks.accent]);

  const tab = searchOpen
    ? { id:'__search', kind:'search' }
    : (tabs.find(t => t.id === activeTab) || tabs[0]);

  const openPR = (pr) => {
    const id = 'pr-' + pr.id;
    if (!tabs.find(t => t.id === id)) {
      const fullPr = pr.id === PR_DETAIL.id ? PR_DETAIL : pr;
      setTabs([...tabs, { id, kind:'pr', pr: fullPr, viewMode:'view' }]);
    }
    setActiveTab(id);
    setSearchOpen(false);
  };

  const closeTab = (id) => {
    const idx = tabs.findIndex(t => t.id === id);
    const next = tabs.filter(t => t.id !== id);
    setTabs(next);
    if (activeTab === id && next.length) {
      setActiveTab(next[Math.max(0, idx-1)].id);
    }
  };

  const setTabMode = (mode) => {
    setSearchOpen(false);
    setTabs(tabs.map(t => t.id === activeTab ? {...t, viewMode: mode} : t));
  };

  const newSearchTab = () => { setSearchOpen(true); };

  const railMode = tab.kind === 'search' ? 'search'
                 : tab.viewMode === 'editor' ? 'editor'
                 : tab.viewMode === 'review' ? 'review' : 'view';

  return (
    <div className={"macwin" + (tweaks.windowed ? ' windowed' : '')} data-density={tweaks.density}>
      {/* title bar */}
      <div className="titlebar">
        <div className="lights">
          <span className="light r"/><span className="light y"/><span className="light g"/>
        </div>
        <div className="titlebar-center">
          <span className="repo">{tab.kind==='pr' ? tab.pr.repo : 'Kol\'s Review'}</span>
          {tab.kind==='pr' && <>
            <span style={{color:'var(--ink-4)'}}>·</span>
            <span className="branch"><IconBranch style={{width:10, height:10}}/>{tab.pr.branch}</span>
          </>}
        </div>
      </div>

      {/* shell */}
      <div className="shell">
        {/* left rail */}
        <div className="rail">
          <button className={"rail-btn" + (railMode==='search' ? ' active':'')} onClick={newSearchTab}>
            <IconSearch/>
            <span className="rail-tooltip">Search PRs · ⌘K</span>
          </button>
          <button className={"rail-btn" + (railMode==='view' ? ' active':'')} onClick={() => tab.kind==='pr' && setTabMode('view')}>
            <IconPR/>
            <span className="rail-tooltip">PR view</span>
          </button>
          <button className={"rail-btn" + (railMode==='review' ? ' active':'')} onClick={() => tab.kind==='pr' && setTabMode('review')}>
            <IconReview/>
            <span className="rail-tooltip">Review</span>
          </button>
          <button className={"rail-btn" + (railMode==='editor' ? ' active':'')} onClick={() => tab.kind==='pr' && setTabMode('editor')}>
            <IconCode/>
            <span className="rail-tooltip">Editor</span>
          </button>

          <div className="rail-spacer"/>
          <button className="rail-btn">
            <IconGear/>
            <span className="rail-tooltip">Settings</span>
          </button>
        </div>

        {/* main area */}
        <div className="main">
          {/* tab strip */}
          <div className="tabbar">
            {tabs.map(t => (
              <div key={t.id} onClick={()=>{ setActiveTab(t.id); setSearchOpen(false); }} className={"tab" + (!searchOpen && t.id===activeTab?' active':'')}>
                <span className={"modedot " + (t.viewMode==='review'?'review':t.viewMode==='editor'?'editor':'')}/>
                <span className="num">#{t.pr.id}</span>
                <span className="ttl">{t.pr.title}</span>
                <span className="x" onClick={(e)=>{e.stopPropagation(); closeTab(t.id);}}><IconClose style={{width:10, height:10}}/></span>
              </div>
            ))}
            <span style={{flex:1, borderBottom:'none', background:'var(--bg-tab)'}}/>
          </div>

          {/* view body — mode toggles live in the left rail */}
          {tab.kind === 'search' && <SearchView onOpenPR={openPR}/>}
          {tab.kind === 'pr' && tab.viewMode === 'view' && <PRView pr={tab.pr} onSwitchMode={setTabMode}/>}
          {tab.kind === 'pr' && tab.viewMode === 'review' && <ReviewView pr={tab.pr} tweaks={tweaks} setTweak={setTweak}/>}
          {tab.kind === 'pr' && tab.viewMode === 'editor' && <EditorView pr={tab.pr}/>}
        </div>
      </div>

      {/* tweaks panel */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Tour layout"/>
        <TweakRadio label="Style" value={tweaks.tourVariant} options={[
          {value:'chapters', label:'Chapters'},
          {value:'reading', label:'Reading'},
        ]} onChange={v => setTweak('tourVariant', v)}/>

        <TweakSection label="Theme"/>
        <TweakSelect label="Accent" value={tweaks.accent} options={[
          {value:'indigo', label:'Indigo (default)'},
          {value:'ember', label:'Ember'},
          {value:'pine', label:'Pine'},
          {value:'graphite', label:'Graphite'},
        ]} onChange={v => setTweak('accent', v)}/>

        <TweakSection label="Layout"/>
        <TweakRadio label="Density" value={tweaks.density} options={[
          {value:'compact', label:'Compact'},
          {value:'regular', label:'Regular'},
        ]} onChange={v => setTweak('density', v)}/>
        <TweakToggle label="Window chrome" value={tweaks.windowed} onChange={v => setTweak('windowed', v)}/>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
