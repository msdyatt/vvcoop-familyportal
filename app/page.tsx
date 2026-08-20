import Image from "next/image";

const facebook = "https://www.facebook.com/groups/960994296456160";
const chapters = [["01","The village","#about"],["02","For families","#families"],["03","Shared rhythm","#calendar"],["04","Resources","#resources"]];

function DiamondRule(){return <div className="diamond-rule" aria-hidden="true"><i/><span>◆</span><i/></div>}

export default function Home(){return <>
  <header><a className="wordmark" href="#top">Veritas <b>Village</b></a><nav>{chapters.map(([,name,href])=><a key={href} href={href}>{name}</a>)}<a className="nav-join" href={facebook} target="_blank" rel="noreferrer">Inquire ↗</a></nav><details><summary>Index</summary><div>{chapters.map(([n,name,href])=><a key={href} href={href}><small>{n}</small>{name}</a>)}</div></details></header>
  <main id="top">
    <section className="cover"><div className="cover-kicker">A Central Texas homeschool co-op <span>Est. by its families</span></div><div className="cover-main"><div className="cover-copy"><p>Come curious.</p><h1>Learning in truth.<br/><em>Growing in community.</em></h1><DiamondRule/><p className="intro">A shared place for families to learn with intention and belong with ease.</p><a className="ink-link" href={facebook} target="_blank" rel="noreferrer">Enter the village <span>↗</span></a></div><div className="cover-mark"><Image src="/veritas-lockup.png" alt="Veritas Village" width={720} height={510} priority/></div></div><div className="folio"><span>Thoughtful</span><span>Welcoming</span><span>Locally rooted</span><b>VV / 26–27</b></div></section>

    <aside className="chapter-index" aria-label="Page index">{chapters.map(([n,name,href])=><a key={href} href={href}><small>{n}</small><span>{name}</span></a>)}</aside>

    <section id="about" className="spread about"><div className="margin-note"><span>01</span><p>Brand promise</p></div><div className="chapter-copy"><p className="eyebrow">The village</p><h2>A well-loved field journal, written together.</h2><p className="dropcap">Veritas Village is a Central Texas homeschool co-op shaped by real family life: books opened together, questions carried outdoors, projects taking shape around shared tables, and parents encouraging one another along the way.</p><p>We are grounded, curious, gracious, capable, and locally rooted—open to a wide world of wonder.</p></div><div className="principles"><blockquote>“A place where families learn in truth and grow in community.”</blockquote><DiamondRule/><dl><div><dt>Gather</dt><dd>Friendship, conversation, and hospitality.</dd></div><div><dt>Discover</dt><dd>Reading, making, nature, and good questions.</dd></div><div><dt>Encourage</dt><dd>Families bringing what they know and growing together.</dd></div></dl></div></section>

    <section id="families" className="spread families"><div className="margin-note"><span>02</span><p>For families</p></div><div className="families-title"><p className="eyebrow">Bring your questions, your gifts, and your kids.</p><h2>A co-op is not a product to consume. It is a village to help shape.</h2></div><div className="field-note"><span>FIELD NOTE / WELCOME</span><p>Current enrollment, class choices, family commitments, and welcome steps are shared directly with interested families.</p><a href={facebook} target="_blank" rel="noreferrer">Ask about joining ↗</a></div><Image className="feather" src="/veritas-feather.png" alt="" width={360} height={500}/></section>

    <section id="calendar" className="spread calendar"><div className="margin-note"><span>03</span><p>Shared rhythm</p></div><div className="calendar-number">26<span>/</span>27</div><div className="calendar-copy"><p className="eyebrow">The co-op year</p><h2>The year has a story.<br/>We write it together.</h2><p>A working calendar and event schedule are maintained for participating families. To protect family privacy, gathering dates and location details stay in the private group.</p><a className="ink-link" href={facebook} target="_blank" rel="noreferrer">Open current events <span>↗</span></a></div></section>

    <section id="resources" className="spread resources"><div className="margin-note"><span>04</span><p>Resources</p></div><div className="resources-copy"><p className="eyebrow">Useful things, shared generously</p><h2>The working shelf.</h2><p>Participating families receive direct access to curriculum materials, family guides, class information, and schedules in the co-op’s shared Drive.</p></div><div className="shelf"><div><small>A</small><strong>Curriculum</strong><span>Planning and class materials</span></div><div><small>B</small><strong>Family guides</strong><span>Expectations and co-op information</span></div><div><small>C</small><strong>Schedules</strong><span>Calendars and event details</span></div></div></section>

    <section className="invitation"><p>Learning in truth. Growing in community.</p><Image src="/veritas-lockup.png" alt="Veritas Village" width={560} height={390}/><h2>Come curious.</h2><a href={facebook} target="_blank" rel="noreferrer">Connect with the private co-op group ↗</a></section>
  </main>
  <footer><span>Veritas Village</span><DiamondRule/><span>Central Texas</span></footer>
  </>}
