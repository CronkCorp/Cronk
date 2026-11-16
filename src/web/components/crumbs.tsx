import type { ReactNode } from "react";
import { Link } from "../router.js";

/** The way back to a Project, optionally followed by more crumbs. */
export function ProjectCrumbs(props: { projectKey: string; children?: ReactNode }) {
  return (
    <div className="muted">
      <Link to="/" className="link">Projects</Link> / <Link to={`/projects/${props.projectKey}`} className="link">{props.projectKey}</Link>
      {props.children}
    </div>
  );
}
