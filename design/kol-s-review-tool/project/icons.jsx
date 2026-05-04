// icons.jsx — small inline SVG icon set, single stroke, 16px box
const _i = (path, opts = {}) => (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
       strokeWidth={opts.sw || 1.5} strokeLinecap="round" strokeLinejoin="round"
       {...props}>{path}</svg>
);

const IconSearch = _i(<><circle cx="7" cy="7" r="4.5"/><path d="m13.5 13.5-3-3"/></>);
const IconPR     = _i(<><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="12.5" r="1.5"/><path d="M4 5v6"/><path d="M12 11V8a2 2 0 0 0-2-2H7.5"/><path d="m9.5 4 -2 2 2 2"/></>);
const IconReview = _i(<><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5h3"/><path d="M5 9.5h6"/><path d="m9 11.5 1.5 1.5 2.5-3"/></>);
const IconCode   = _i(<><path d="m6 5-3 3 3 3"/><path d="m10 5 3 3-3 3"/></>);
const IconBranch = _i(<><circle cx="4" cy="3.5" r="1.5"/><circle cx="4" cy="12.5" r="1.5"/><circle cx="12" cy="6" r="1.5"/><path d="M4 5v6"/><path d="M12 7.5V8a2 2 0 0 1-2 2H7a3 3 0 0 0-3 3"/></>);
const IconClose  = _i(<><path d="m4 4 8 8"/><path d="m12 4-8 8"/></>);
const IconChevR  = _i(<><path d="m6 4 4 4-4 4"/></>);
const IconChevD  = _i(<><path d="m4 6 4 4 4-4"/></>);
const IconChevU  = _i(<><path d="m4 10 4-4 4 4"/></>);
const IconCheck  = _i(<><path d="m3 8 3 3 7-7"/></>);
const IconDot    = _i(<><circle cx="8" cy="8" r="1" fill="currentColor"/></>);
const IconSparkle= _i(<><path d="M8 2v4M8 10v4M2 8h4M10 8h4M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2"/></>);
const IconFile   = _i(<><path d="M9 2H4v12h8V5z"/><path d="M9 2v3h3"/></>);
const IconFolder = _i(<><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v6.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5z"/></>);
const IconComment= _i(<><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5z"/></>);
const IconReact  = _i(<><circle cx="8" cy="8" r="1" fill="currentColor"/><ellipse cx="8" cy="8" rx="6" ry="2.5"/><ellipse cx="8" cy="8" rx="6" ry="2.5" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6" ry="2.5" transform="rotate(120 8 8)"/></>);
const IconPlus   = _i(<><path d="M8 3v10M3 8h10"/></>);
const IconFilter = _i(<><path d="M2.5 4h11M5 8h6M7 12h2"/></>);
const IconMore   = _i(<><circle cx="3" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="13" cy="8" r="1" fill="currentColor"/></>);
const IconBook   = _i(<><path d="M3 3h6a2 2 0 0 1 2 2v8H5a2 2 0 0 0-2 2z" /><path d="M13 3H9.5"/><path d="M13 13V3"/></>);
const IconStack  = _i(<><path d="M2 5l6-3 6 3-6 3z"/><path d="m2 8 6 3 6-3"/><path d="m2 11 6 3 6-3"/></>);
const IconClock  = _i(<><circle cx="8" cy="8" r="6"/><path d="M8 5v3l2 2"/></>);
const IconTour   = _i(<><path d="M2 13V3l4 1 4-1 4 1v10l-4-1-4 1-4-1z"/><path d="M6 4v9M10 3v9"/></>);
const IconList   = _i(<><path d="M3 4h10M3 8h10M3 12h10"/></>);
const IconSplit  = _i(<><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M8 3v10"/></>);
const IconLightbulb = _i(<><path d="M8 2a4 4 0 0 0-2.5 7.1V11h5V9.1A4 4 0 0 0 8 2z"/><path d="M6.5 13h3M7 14.5h2"/></>);
const IconPanel  = _i(<><rect x="2" y="3" width="12" height="10" rx="1"/><path d="M6 3v10"/></>);
const IconKey    = _i(<><circle cx="5" cy="11" r="2.5"/><path d="m7 9 5-5"/><path d="m10 6 1.5 1.5"/></>);
const IconGear   = _i(<><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4"/></>);
const IconFlow   = _i(<><rect x="2" y="2.5" width="4" height="3" rx="0.5"/><rect x="10" y="2.5" width="4" height="3" rx="0.5"/><rect x="2" y="10.5" width="4" height="3" rx="0.5"/><rect x="10" y="10.5" width="4" height="3" rx="0.5"/><path d="M6 4h4M6 12h4M4 5.5v5M12 5.5v5"/></>);

Object.assign(window, {
  IconSearch, IconPR, IconReview, IconCode, IconBranch, IconClose,
  IconChevR, IconChevD, IconChevU, IconCheck, IconDot, IconSparkle,
  IconFile, IconFolder, IconComment, IconReact, IconPlus, IconFilter,
  IconMore, IconBook, IconStack, IconClock, IconTour, IconList,
  IconSplit, IconLightbulb, IconPanel, IconKey, IconGear, IconFlow,
});
