import { useState } from "preact/hooks";
import type { Bridge } from "../store";

type SystemKind = "feature" | "bug";

export function NewSystem({ b }: { b: Bridge }) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [kind, setKind] = useState<SystemKind>("feature");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = () => {
    setSlug("");
    setTitle("");
    setBrief("");
    setKind("feature");
    setError(null);
  };
  const cancel = () => {
    clear();
    setOpen(false);
  };
  const create = async () => {
    const values = { slug: slug.trim(), title: title.trim(), brief: brief.trim(), kind };
    if (values.slug === "" || values.title === "" || values.brief === "") return;
    setBusy(true);
    setError(null);
    const result = await b.run("system.create", values);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const data = result.data as { systemId: string };
    clear();
    setOpen(false);
    b.selectSystem(data.systemId);
  };

  if (!open) {
    return <div className="new-system"><button className="btn" type="button" onClick={() => setOpen(true)}>New system</button></div>;
  }
  return (
    <form className="assignment-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label>slug<input className="field" value={slug} disabled={busy} onInput={(event) => setSlug(event.currentTarget.value)} /></label>
      <label>title<input className="field" value={title} disabled={busy} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
      <label>brief<textarea className="field" value={brief} disabled={busy} onInput={(event) => setBrief(event.currentTarget.value)} /></label>
      <label>kind<select className="field" value={kind} disabled={busy} onChange={(event) => setKind(event.currentTarget.value as SystemKind)}>
        <option value="feature">feature</option>
        <option value="bug">bug</option>
      </select></label>
      <div className="assignment-buttons">
        <button className="btn" type="submit" disabled={busy || slug.trim() === "" || title.trim() === "" || brief.trim() === ""}>Create</button>
        <button className="btn" type="button" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
      {error !== null && <div className="msg-error">{error}</div>}
    </form>
  );
}
