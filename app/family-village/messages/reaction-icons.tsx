/**
 * The six reactions, drawn for the co-op: a flat disc in a brand colour, a cream shape with an inked outline, and a
 * gold wash set slightly off-register behind it. The database still stores the same six emoji (see REACTIONS in
 * lib/messages.ts); this only decides how each one is drawn, so every phone shows the same picture.
 *
 * The colours are part of the artwork and do not change with Light and Dark.
 */
import type { ReactNode } from "react";
import type { ReactionEmoji } from "../../../lib/messages";

const INK = "#0b2a3d";
const CREAM = "#faf7f1";
const WARM = "#f4e4dc";
const GOLD = "#f2c14e";
const RED = "#bb6141";

const ink = { fill: "none", stroke: INK, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const centre = "translate(24 24) scale(.8) translate(-24 -24)";
const wash = `translate(25.6 25.6) scale(.8) translate(-24 -24)`;

/** A cream shape with its ink outline, and the gold wash behind it. */
function Body({ paths, inner }: { paths: string[]; inner?: ReactNode }) {
  return <>
    <g transform={wash} fill={GOLD} fillOpacity={0.85}>{paths.map((d) => <path key={d} d={d} />)}</g>
    <g transform={centre}>
      {paths.map((d) => <path key={d} d={d} fill={CREAM} />)}
      {paths.map((d) => <path key={`o${d}`} d={d} {...ink} />)}
      {inner}
    </g>
  </>;
}

const FACE = "M24 6a18 18 0 1 0 0 36a18 18 0 1 0 0-36z";

function Thumb() {
  return <Body paths={["M9 22h7v19H9a2 2 0 0 1-2-2V24a2 2 0 0 1 2-2z", "M18 22l7-14c3.2 0 5.2 2.4 4.2 6l-1.6 6H38a3.5 3.5 0 0 1 3.4 4.4l-3 12A3.5 3.5 0 0 1 35 41H18z"]}
    inner={<><path d="M26 31h11" {...ink} /><path d="M25 36h10" {...ink} /></>} />;
}

function Heart() {
  return <Body paths={["M24 41C8 30 5.5 19.5 11.5 14c4.2-3.8 9.6-1.8 12.5 3 2.9-4.8 8.3-6.8 12.5-3C42.5 19.5 40 30 24 41z"]} inner={<path d="M13 19q1.5-3 5-3.2" {...ink} />} />;
}

function Laugh() {
  return <Body paths={[FACE]} inner={<>
    <path d="M14 28h20a10 10 0 0 1-20 0z" fill={INK} />
    <path d="M14.5 20q3-4.5 6.5 0" {...ink} /><path d="M27 20q3.5-4.5 6.5 0" {...ink} />
  </>} />;
}

function Party() {
  return <Body paths={["M7 42l9-28 18 18z"]} inner={<>
    <path d="M12 35l7 7" {...ink} /><path d="M16 24l12 12" {...ink} /><path d="M22 19q5-8 10-3" {...ink} />
    {["M35 8a2.4 2.4 0 1 0 .1 0z", "M42 20a2 2 0 1 0 .1 0z", "M25 6a2 2 0 1 0 .1 0z", "M37 29l4 1-1 4-4-1z", "M26 17l3-3 3 3-3 3z"].map((d) => <path key={d} d={d} fill={GOLD} stroke={INK} strokeWidth={1.4} strokeLinejoin="round" />)}
  </>} />;
}

function Wow() {
  return <Body paths={[FACE]} inner={<>
    <path d="M19 22a2.5 3.5 0 1 0 .1 0z" fill={INK} /><path d="M29 22a2.5 3.5 0 1 0 .1 0z" fill={INK} /><path d="M24 29a4.5 6 0 1 0 .1 0z" fill={INK} />
    <path d="M14 15q4-3 8-1" {...ink} /><path d="M26 14q4-2 8 1" {...ink} />
  </>} />;
}

/** Two hands pressed together at a lean, the front thumb sticking out, a separate cuff on each wrist. */
function Thanks() {
  const lean = 6;
  const left = `rotate(${lean} 24 40)`;
  const right = `rotate(${-lean} 24 40)`;
  return <>
    <g transform={wash} fill={GOLD} fillOpacity={0.85}>
      <rect x="12.5" y="4" width="11.5" height="31" rx="5.6" transform={left} />
      <rect x="24" y="4" width="11.5" height="31" rx="5.6" transform={right} />
    </g>
    <g transform="translate(24 24) scale(.96) translate(-24 -24)">
      <rect x="12.5" y="4" width="11.5" height="31" rx="5.6" transform={left} fill={CREAM} />
      <rect x="12.5" y="4" width="11.5" height="31" rx="5.6" transform={left} {...ink} />
      <rect x="24" y="4" width="11.5" height="31" rx="5.6" transform={right} fill={CREAM} />
      <rect x="24" y="4" width="11.5" height="31" rx="5.6" transform={right} {...ink} />
      <path d="M33.500 19c5-1.200 8 1.300 7.600 5-.4 3.700-4.300 5.200-8.300 4.400z" fill={CREAM} />
      <path d="M33.500 19c5-1.200 8 1.300 7.600 5-.4 3.700-4.300 5.200-8.300 4.400" {...ink} />
      <rect x="10" y="36.500" width="13.500" height="8" rx="2.500" transform={left} fill={WARM} />
      <rect x="10" y="36.500" width="13.500" height="8" rx="2.500" transform={left} {...ink} />
      <rect x="25" y="36.500" width="13.500" height="8" rx="2.500" transform={right} fill={WARM} />
      <rect x="25" y="36.500" width="13.500" height="8" rx="2.500" transform={right} {...ink} />
      <path d="M18 11v8" transform={left} {...ink} /><path d="M30 11v8" transform={right} {...ink} />
    </g>
  </>;
}

const DISC: Record<ReactionEmoji, string> = { "👍": "#4a6a86", "❤️": RED, "😂": "#c28a2c", "🎉": "#a15a64", "🙏": "#637469", "😮": "#3d7479" };
const SHAPE: Record<ReactionEmoji, () => ReactNode> = { "👍": Thumb, "❤️": Heart, "😂": Laugh, "🎉": Party, "🙏": Thanks, "😮": Wow };

export default function ReactionIcon({ emoji, size = 24 }: { emoji: ReactionEmoji; size?: number }) {
  const Shape = SHAPE[emoji];
  return <svg className="reaction-icon" viewBox="0 0 48 48" width={size} height={size} aria-hidden="true" focusable="false">
    <circle cx="24" cy="24" r="24" fill={DISC[emoji]} />
    <Shape />
  </svg>;
}
