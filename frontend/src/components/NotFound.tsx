import { Link, useLocation } from "react-router-dom";

/**
 * 404 view for SPA routes that don't match any registered route in
 * `App.tsx`. Examples: a typo'd URL (`/neuron/123` — there's no
 * positional-id route, root_ids live in `?root=` query state) or a
 * stale link from before a route was renamed/removed.
 *
 * The HTTP response is still 200 (Flask served the SPA shell normally;
 * the React side decided no route matched). The URL stays put so the
 * user can see what they typed and edit it. Two shortcut links cover
 * the common recovery paths — back to the neuron view, or to the
 * tables index.
 *
 * Why no HTTP 404: this is a single-page app served from one route
 * pattern (`<path:path>`) backend-side. Returning HTTP 404 would
 * require the backend to know which paths the SPA considers valid,
 * duplicating the React Router config in Flask. Frontend-only 404 is
 * the convention for SPAs (Twitter, Vercel, etc.); SEO would be a
 * reason to do hybrid status, but this app isn't indexable.
 */
export function NotFound() {
  const location = useLocation();
  return (
    <div className="not-found">
      <h1>404</h1>
      <p className="not-found-detail">
        No page at <code>{location.pathname}</code>
      </p>
      <p className="not-found-hint">
        Root IDs and table names live in URL query params, not in the path.
        For example: <code>/neuron?ds=minnie65_public&amp;root=864691135…</code>
      </p>
      <div className="not-found-links">
        <Link to="/neuron">Go to neuron view</Link>
        <Link to="/tables">Browse tables</Link>
      </div>
    </div>
  );
}
