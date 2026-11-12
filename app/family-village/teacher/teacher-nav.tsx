/** The teacher section's side links (desktop). Shared by the class list and the pages in workspace.tsx. */
export type TeacherNavKey = "home" | "news" | "classes" | "print";

export default function TeacherNav({ active }: { active: TeacherNavKey }) {
  return <article className="workspace-nav">
    <a className={active === "news" ? "active" : ""} href="/family-village/teacher/news">Teaching team news</a>
    <a className={active === "classes" ? "active" : ""} href="/family-village/teacher/classes">Classes</a>
    <a className={active === "print" ? "active" : ""} href="/family-village/teacher/print">Print queue</a>
  </article>;
}
